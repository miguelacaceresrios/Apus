package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

//go:embed ui.html
var uiHTML []byte

type uiServer struct {
	bases []string
	token string
}

func cmdUI(args []string) int {
	port := 7373
	open := true
	var dirs []string

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--port", "-p":
			if i+1 >= len(args) {
				return dieMsg(codeUsage, "--port necesita un número", "")
			}
			i++
			n, err := strconv.Atoi(args[i])
			if err != nil || n < 0 || n > 65535 {
				return dieMsg(codeUsage, "puerto inválido: "+args[i], "")
			}
			port = n
		case "--dir", "-d":
			if i+1 >= len(args) {
				return dieMsg(codeUsage, "--dir necesita una ruta", "")
			}
			i++
			dirs = append(dirs, args[i])
		case "--no-open":
			open = false
		case "-q", "--quiet":
			quiet = true
		case "-h", "--help":
			printUsage()
			return codeOK
		default:
			return dieMsg(codeUsage, "opción desconocida: "+args[i], "probá 'apus --help'")
		}
	}

	bases := repoBases(dirs)
	if len(bases) == 0 {
		return dieMsg(codeRepo, "no sé dónde buscar repos", "pasá --dir RUTA o definí APUS_REPOS_DIR")
	}

	srv := &uiServer{bases: bases, token: randomToken()}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return dieMsg(codeRepo, "no pude abrir el puerto "+strconv.Itoa(port)+": "+firstLine(err.Error()),
			"probá con otro: apus ui --port 7400")
	}
	addr := ln.Addr().(*net.TCPAddr)
	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", addr.Port, srv.token)

	okMsg(fmt.Sprintf("apus ui escuchando en http://127.0.0.1:%d", addr.Port))
	note("repos en: " + strings.Join(bases, ", "))
	note("cortá con Ctrl+C")
	if open {
		openBrowser(url)
	} else {
		note(url)
	}

	if err := http.Serve(ln, srv.routes()); err != nil {
		return dieMsg(codeRepo, "el servidor se cayó: "+firstLine(err.Error()), "")
	}
	return codeOK
}

func randomToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "apus-sin-token"
	}
	return hex.EncodeToString(b)
}

func (s *uiServer) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.index)
	mux.HandleFunc("/api/repos", s.guard(s.apiRepos))
	mux.HandleFunc("/api/repo", s.guard(s.apiRepo))
	mux.HandleFunc("/api/diff", s.guard(s.apiDiff))
	mux.HandleFunc("/api/push", s.guard(s.apiPush))
	mux.HandleFunc("/api/gh", s.guard(s.apiGH))
	mux.HandleFunc("/api/link", s.guard(s.apiLink))
	return mux
}

// index entrega la página. El enlace que abre la terminal trae el token; a
// partir de ahí vive en una cookie, así que recargar la página sigue andando.
func (s *uiServer) index(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.URL.Query().Get("t") == s.token {
		http.SetCookie(w, &http.Cookie{
			Name: "apus", Value: s.token, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteStrictMode,
		})
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if c, err := r.Cookie("apus"); err != nil || c.Value != s.token {
		http.Error(w, "esta ventana perdió el permiso: volvé a correr 'apus ui' en la terminal", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(uiHTML)
}

// guard deja pasar sólo a la propia página: cookie del token más una cabecera
// que un sitio ajeno no puede mandar sin que el navegador pida permiso antes.
func (s *uiServer) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("apus")
		if err != nil || c.Value != s.token || r.Header.Get("X-Apus") == "" {
			http.Error(w, "sin permiso", http.StatusForbidden)
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

// repoView es lo que la página necesita saber de un repo.
type repoView struct {
	*Repo
	Icon    string `json:"icon"`
	Summary string `json:"summary"`
	Browse  string `json:"browse"`
}

func view(r *Repo) repoView {
	return repoView{Repo: r, Icon: icon(r), Summary: r.Summary(), Browse: browseURL(r.RemoteURL)}
}

func (s *uiServer) apiRepos(w http.ResponseWriter, r *http.Request) {
	repos := findRepos(s.bases, 3)
	out := make([]repoView, 0, len(repos))
	for _, rp := range repos {
		out = append(out, view(rp))
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": out, "bases": s.bases})
}

// resolveRepo carga el repo de una ruta pedida por la página.
func resolveRepo(path string) (*Repo, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("falta la ruta del repo")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("la ruta del repo tiene que ser absoluta")
	}
	return LoadRepo(path)
}

func (s *uiServer) apiRepo(w http.ResponseWriter, r *http.Request) {
	repo, err := resolveRepo(r.URL.Query().Get("path"))
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, view(repo))
}

// apiDiff muestra el diff de un archivo; si es nuevo, sus primeras líneas.
func (s *uiServer) apiDiff(w http.ResponseWriter, r *http.Request) {
	repo, err := resolveRepo(r.URL.Query().Get("path"))
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	file := r.URL.Query().Get("file")
	if err := safeRelPath(file); err != nil {
		badRequest(w, err.Error())
		return
	}
	out, _ := git(repo.Path, "diff", "HEAD", "--", file)
	if strings.TrimSpace(out) == "" {
		out, _ = git(repo.Path, "diff", "--", file)
	}
	if strings.TrimSpace(out) == "" {
		// Archivo nuevo: mostramos lo que tiene adentro.
		if data, err := os.ReadFile(filepath.Join(repo.Path, filepath.FromSlash(file))); err == nil {
			body := string(data)
			if len(body) > 20000 {
				body = body[:20000] + "\n… (recortado)"
			}
			out = body
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"diff": out})
}

// safeRelPath evita que la página pida rutas de más o que git las confunda con
// opciones.
func safeRelPath(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("falta el archivo")
	}
	if strings.HasPrefix(p, "-") {
		return fmt.Errorf("ruta inválida: %s", p)
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") {
		return fmt.Errorf("la ruta tiene que ser relativa al repo: %s", p)
	}
	for _, part := range strings.Split(filepath.ToSlash(p), "/") {
		if part == ".." {
			return fmt.Errorf("ruta inválida: %s", p)
		}
	}
	return nil
}

type pushRequest struct {
	Path    string   `json:"path"`
	Message string   `json:"message"`
	Paths   []string `json:"paths"`
	DryRun  bool     `json:"dryRun"`
}

func (s *uiServer) apiPush(w http.ResponseWriter, r *http.Request) {
	var req pushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		badRequest(w, "no entendí el pedido: "+err.Error())
		return
	}
	repo, err := resolveRepo(req.Path)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	for _, p := range req.Paths {
		if err := safeRelPath(p); err != nil {
			badRequest(w, err.Error())
			return
		}
	}

	flow := &Flow{DryRun: req.DryRun}
	res, err := flow.Push(repo, req.Message, req.Paths)

	fresh, ferr := LoadRepo(repo.Path)
	if ferr != nil {
		fresh = repo
	}
	body := map[string]any{"result": res, "repo": view(fresh)}
	if err != nil {
		if f, ok := err.(*Fail); ok {
			body["error"], body["hint"], body["code"] = f.Msg, f.Hint, f.Code
		} else {
			body["error"] = err.Error()
		}
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *uiServer) apiGH(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{
		"available": ghAvailable(),
		"ready":     ghReady(),
		"protocol":  "https",
		"repos":     []GHRepo{},
	}
	if ghAvailable() {
		out["protocol"] = ghProtocol()
	}
	if ghReady() {
		if repos, err := ghList(); err == nil {
			out["repos"] = repos
		} else {
			out["error"] = firstLine(err.Error())
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type linkRequest struct {
	Path       string `json:"path"`
	URL        string `json:"url"`        // URL pegada, usuario/repo, o ruta local
	Create     string `json:"create"`     // nombre del repo nuevo a crear en GitHub
	Visibility string `json:"visibility"` // private | public
}

func (s *uiServer) apiLink(w http.ResponseWriter, r *http.Request) {
	var req linkRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		badRequest(w, "no entendí el pedido: "+err.Error())
		return
	}
	repo, err := resolveRepo(req.Path)
	if err != nil {
		badRequest(w, err.Error())
		return
	}

	var url, label string
	if name := strings.TrimSpace(req.Create); name != "" {
		if !ghReady() {
			badRequest(w, "para crear el repo necesitás gh con sesión iniciada: 'gh auth login'")
			return
		}
		full, u, err := ghCreate(name, req.Visibility)
		if err != nil {
			badRequest(w, "gh no pudo crear el repo: "+firstLine(err.Error()))
			return
		}
		url, label = u, full
	} else {
		u, err := normalizeRemote(req.URL)
		if err != nil {
			badRequest(w, err.Error())
			return
		}
		url = u
		if label = browseURL(u); label == "" {
			label = u
		} else {
			label = strings.TrimPrefix(label, "https://")
		}
	}

	if err := setRemote(repo.Path, "origin", url); err != nil {
		badRequest(w, "no pude configurar el remoto: "+firstLine(err.Error()))
		return
	}
	fresh, ferr := LoadRepo(repo.Path)
	if ferr != nil {
		fresh = repo
	}
	writeJSON(w, http.StatusOK, map[string]any{"remote": "origin", "label": label, "url": url, "repo": view(fresh)})
}

// openBrowser abre la UI como ventana de aplicación si encuentra un navegador
// basado en Chromium; si no, en el navegador por defecto.
func openBrowser(url string) {
	appArg := "--app=" + url
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		pf := os.Getenv("ProgramFiles")
		pf86 := os.Getenv("ProgramFiles(x86)")
		local := os.Getenv("LOCALAPPDATA")
		candidates = []string{
			filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
			filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
			filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
		}
	case "darwin":
		candidates = nil
	default:
		candidates = []string{"google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"}
	}

	for _, c := range candidates {
		path := c
		if !filepath.IsAbs(c) {
			p, err := exec.LookPath(c)
			if err != nil {
				continue
			}
			path = p
		} else if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := exec.Command(path, appArg, "--new-window").Start(); err == nil {
			return
		}
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		note("abrí esto a mano: " + url)
	}
}
