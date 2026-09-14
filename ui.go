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
	"sync"
	"time"
)

//go:embed ui/index.html
var uiHTML []byte

type uiServer struct {
	bases    []string
	token    string
	host     string // "127.0.0.1:puerto": lo único que se acepta en la cabecera Host
	autoQuit bool   // apagarse cuando se cierra la ventana (atajo de escritorio)

	mu       sync.Mutex
	lastSeen time.Time // último pedido de la página
	byeAt    time.Time // aviso de "me cierro" que mandó la página
}

func cmdUI(args []string) int {
	port, portSet := 7373, false
	open := true
	// Sin terminal no hay Ctrl+C: la única forma de cerrar apus es cerrar la ventana.
	autoQuit := guiMode()
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
			port, portSet = n, true
		case "--dir", "-d":
			if i+1 >= len(args) {
				return dieMsg(codeUsage, "--dir necesita una ruta", "")
			}
			i++
			dirs = append(dirs, args[i])
		case "--no-open":
			open = false
		case "--quit-on-close":
			autoQuit = true
		case "-q", "--quiet":
			quiet = true
		case "-h", "--help":
			printUsage()
			return codeOK
		default:
			return dieMsg(codeUsage, "opción desconocida: "+args[i], "probá 'apus --help'")
		}
	}

	os.Setenv("GIT_TERMINAL_PROMPT", "0")

	bases := repoBases(dirs)
	if len(bases) == 0 {
		return dieMsg(codeRepo, "no sé dónde buscar repos", "pasá --dir RUTA o definí APUS_REPOS_DIR")
	}

	srv := &uiServer{bases: bases, token: randomToken(), autoQuit: autoQuit, lastSeen: time.Now()}
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil && !portSet {
		// El puerto de siempre está ocupado (¿otra ventana de apus abierta?): uno libre.
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		return dieMsg(codeRepo, "no pude abrir el puerto "+strconv.Itoa(port)+": "+firstLine(err.Error()),
			"probá con otro: apus ui --port 7400")
	}
	addr := ln.Addr().(*net.TCPAddr)
	srv.host = fmt.Sprintf("127.0.0.1:%d", addr.Port)
	url := "http://" + srv.host + "/?t=" + srv.token

	okMsg(fmt.Sprintf("apus ui escuchando en http://127.0.0.1:%d", addr.Port))
	note("repos en: " + strings.Join(bases, ", "))
	if autoQuit {
		note("se apaga solo al cerrar la ventana")
		go srv.watchdog()
	} else {
		note("cortá con Ctrl+C")
	}
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

// seen anota que la página sigue del otro lado.
func (s *uiServer) seen() {
	s.mu.Lock()
	s.lastSeen = time.Now()
	s.mu.Unlock()
}

// watchdog es la red de seguridad del modo --quit-on-close: si la ventana se
// fue sin avisar (o se colgó el navegador), apus no queda corriendo para siempre.
func (s *uiServer) watchdog() {
	for range time.Tick(30 * time.Second) {
		s.mu.Lock()
		quiet := time.Since(s.lastSeen)
		s.mu.Unlock()
		if quiet > 5*time.Minute {
			os.Exit(0)
		}
	}
}

// bye lo llama la página cuando se cierra. Esperamos unos segundos por si fue
// una recarga: si vuelve a pedir algo, nos quedamos.
func (s *uiServer) bye(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie("apus")
	if err != nil || c.Value != s.token || r.Host != s.host {
		http.Error(w, "sin permiso", http.StatusForbidden)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	if !s.autoQuit {
		return
	}
	s.mu.Lock()
	s.byeAt = time.Now()
	s.mu.Unlock()
	go func() {
		time.Sleep(4 * time.Second)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.lastSeen.After(s.byeAt) {
			return // era una recarga: la página volvió
		}
		os.Exit(0)
	}()
}

func (s *uiServer) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.index)
	mux.HandleFunc("/api/bye", s.bye)
	mux.HandleFunc("/api/ping", s.guard(s.apiPing))
	mux.HandleFunc("/api/pick", s.guard(s.apiPick))
	mux.HandleFunc("/api/inspect", s.guard(s.apiInspect))
	mux.HandleFunc("/api/send", s.guard(s.apiSend))
	return mux
}

// index entrega la página. El enlace que abre la terminal trae el token; a
// partir de ahí vive en una cookie, así que recargar la página sigue andando.
func (s *uiServer) index(w http.ResponseWriter, r *http.Request) {
	if r.Host != s.host {
		http.Error(w, "sin permiso", http.StatusForbidden)
		return
	}
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

// guard deja pasar sólo a la propia página: cookie del token, una cabecera que
// un sitio ajeno no puede mandar sin que el navegador pida permiso antes, y el
// Host exacto (así un dominio que resuelva a 127.0.0.1 tampoco entra).
func (s *uiServer) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("apus")
		if err != nil || c.Value != s.token || r.Header.Get("X-Apus") == "" || r.Host != s.host {
			http.Error(w, "sin permiso", http.StatusForbidden)
			return
		}
		s.seen()
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

// apiPing lo manda la página cada tanto: mientras la ventana esté abierta,
// el modo --quit-on-close no apaga nada.
func (s *uiServer) apiPing(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// apiPick abre el selector de carpetas del sistema y espera a que elijas.
func (s *uiServer) apiPick(w http.ResponseWriter, r *http.Request) {
	start := r.URL.Query().Get("from")
	if start == "" && len(s.bases) > 0 {
		start = s.bases[0]
	}
	dir, err := pickFolder(start)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	if dir == "" {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dir": dir, "inspect": Inspect(dir)})
}

func (s *uiServer) apiInspect(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Inspect(strings.TrimSpace(r.URL.Query().Get("dir"))))
}

type sendRequest struct {
	Dir string `json:"dir"`
	URL string `json:"url"`
}

func (s *uiServer) apiSend(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		badRequest(w, "no entendí el pedido: "+err.Error())
		return
	}
	res, err := Send(strings.TrimSpace(req.Dir), req.URL)
	body := map[string]any{"result": res, "inspect": Inspect(strings.TrimSpace(req.Dir))}
	if err != nil {
		if f, ok := err.(*Fail); ok {
			body["error"], body["hint"], body["code"] = f.Msg, f.Hint, f.Code
		} else {
			body["error"] = err.Error()
		}
	}
	writeJSON(w, http.StatusOK, body)
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
		if err := exec.Command(path, appArg, "--new-window", "--window-size=540,500").Start(); err == nil {
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
