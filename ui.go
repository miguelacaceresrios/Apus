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

// El ícono de la ventana, para la barra de título y la de tareas. Va el .ico,
// con cada tamaño dibujado aparte: si el navegador achica un PNG grande, a
// 16px queda borroso.
//
//go:embed assets/apus.ico
var uiIcon []byte

// El PNG grande es para el menú de aplicaciones de Linux.
//
//go:embed assets/apus.png
var appIcon []byte

// uiServer es una ventana local: una página servida en 127.0.0.1 que solo
// atiende a sí misma. La usan apus y Aerodramus, cada una con su página.
type uiServer struct {
	app      string // "apus" o "aerodramus": los mensajes y el nombre de la cookie
	page     []byte
	favicon  []byte
	bases    []string
	token    string
	host     string // "127.0.0.1:puerto": lo único que se acepta en la cabecera Host
	cookie   string // una por app y puerto: las cookies no distinguen puertos
	autoQuit bool   // apagarse cuando se cierra la ventana (atajo de escritorio)

	mu       sync.Mutex
	lastSeen time.Time // último pedido de la página
	byeAt    time.Time // aviso de "me cierro" que mandó la página
	login    string    // usuario de GitHub del token guardado, si ya se sabe
}

func newUIServer(app string, page, favicon []byte, autoQuit bool) *uiServer {
	return &uiServer{app: app, page: page, favicon: favicon, token: randomToken(), autoQuit: autoQuit, lastSeen: time.Now()}
}

// serve abre el puerto (o uno libre si está ocupado y no lo pidieron), abre la
// ventana y atiende hasta que se cierre. routes agrega lo propio de cada app.
func (s *uiServer) serve(port int, portSet, open bool, size string, routes func(mux *http.ServeMux)) int {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil && !portSet {
		// El puerto de siempre está ocupado (¿otra ventana abierta?): uno libre.
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		return dieMsg(codeRepo, "no pude abrir el puerto "+strconv.Itoa(port)+": "+firstLine(err.Error()),
			"probá con otro: --port 7400")
	}
	addr := ln.Addr().(*net.TCPAddr)
	s.host = fmt.Sprintf("127.0.0.1:%d", addr.Port)
	s.cookie = fmt.Sprintf("%s_%d", s.app, addr.Port)
	url := "http://" + s.host + "/?t=" + s.token

	okMsg(fmt.Sprintf("%s escuchando en http://%s", s.app, s.host))
	if len(s.bases) > 0 {
		note("repos en: " + strings.Join(s.bases, ", "))
	}
	if s.autoQuit {
		note("se apaga solo al cerrar la ventana")
		go s.watchdog()
	} else {
		note("cortá con Ctrl+C")
	}
	if open {
		openBrowser(url, size)
	} else {
		note(url)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.index)
	mux.HandleFunc("/favicon.ico", s.icon)
	mux.HandleFunc("/api/bye", s.bye)
	mux.HandleFunc("/api/ping", s.guard(s.apiPing))
	routes(mux)
	if err := http.Serve(ln, mux); err != nil {
		return dieMsg(codeRepo, "el servidor se cayó: "+firstLine(err.Error()), "")
	}
	return codeOK
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

	srv := newUIServer("apus", uiHTML, uiIcon, autoQuit)
	srv.bases = bases
	return srv.serve(port, portSet, open, "560,620", func(mux *http.ServeMux) {
		mux.HandleFunc("/api/pick", srv.guard(srv.apiPick))
		mux.HandleFunc("/api/inspect", srv.guard(srv.apiInspect))
		mux.HandleFunc("/api/send", srv.guard(srv.apiSend))
		mux.HandleFunc("/api/resolve", srv.guard(srv.apiResolve))
		mux.HandleFunc("/api/token", srv.guard(srv.apiToken))
		mux.HandleFunc("/api/workflow", srv.guard(srv.apiWorkflow))
	})
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
// fue sin avisar (o se colgó el navegador), no queda corriendo para siempre.
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

// allowed dice si el pedido viene de la propia página: el Host exacto y la
// cookie con el token.
func (s *uiServer) allowed(r *http.Request) bool {
	c, err := r.Cookie(s.cookie)
	return err == nil && c.Value == s.token && r.Host == s.host
}

// bye lo llama la página cuando se cierra. Esperamos unos segundos por si fue
// una recarga: si vuelve a pedir algo, nos quedamos.
func (s *uiServer) bye(w http.ResponseWriter, r *http.Request) {
	if !s.allowed(r) {
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

// index entrega la página. El enlace que abre la ventana trae el token; a
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
			Name: s.cookie, Value: s.token, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteStrictMode,
		})
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if !s.allowed(r) {
		http.Error(w, "esta ventana perdió el permiso: cerrala y volvé a abrir "+s.app, http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(s.page)
}

// icon no pide el token: es una imagen pública, y el navegador la pide también
// para la barra de tareas, a veces sin la cookie.
func (s *uiServer) icon(w http.ResponseWriter, r *http.Request) {
	if r.Host != s.host {
		http.Error(w, "sin permiso", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "image/x-icon")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(s.favicon)
}

// guard deja pasar sólo a la propia página: cookie del token, una cabecera que
// un sitio ajeno no puede mandar sin que el navegador pida permiso antes, y el
// Host exacto (así un dominio que resuelva a 127.0.0.1 tampoco entra).
func (s *uiServer) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.allowed(r) || r.Header.Get("X-Apus") == "" {
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
	writeJSON(w, http.StatusOK, map[string]any{"dir": dir, "inspect": InspectFull(dir)})
}

func (s *uiServer) apiInspect(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, InspectFull(strings.TrimSpace(r.URL.Query().Get("dir"))))
}

type sendRequest struct {
	Dir    string `json:"dir"`
	URL    string `json:"url"`
	Action string `json:"action"`
	Lease  string `json:"lease"`
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "solo POST", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		badRequest(w, "no entendí el pedido: "+err.Error())
		return false
	}
	return true
}

// flight arma la respuesta de "Subir" y de sus salidas: el resultado, cómo
// quedó la carpeta, y si falló, el porqué para que la página ofrezca qué hacer.
func flight(w http.ResponseWriter, dir string, res *Result, err error) {
	body := map[string]any{"result": res, "inspect": InspectFull(dir)}
	if err != nil {
		if f, ok := err.(*Fail); ok {
			body["error"], body["hint"], body["code"], body["reason"] = f.Msg, f.Hint, f.Code, f.Reason
		} else {
			body["error"] = err.Error()
		}
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *uiServer) apiSend(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if !decode(w, r, &req) {
		return
	}
	dir := strings.TrimSpace(req.Dir)
	res, err := Send(dir, req.URL)
	flight(w, dir, res, err)
}

// apiResolve aplica la salida que se eligió cuando GitHub rechazó el push.
func (s *uiServer) apiResolve(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if !decode(w, r, &req) {
		return
	}
	dir := strings.TrimSpace(req.Dir)
	res, err := Resolve(dir, req.Action, req.Lease)
	flight(w, dir, res, err)
}

// apiToken guarda, muestra el estado o borra el token de GitHub. El token
// entra por acá y va derecho al llavero del sistema: nunca vuelve a la página,
// ni a un archivo, ni a un log.
func (s *uiServer) apiToken(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		_, err := loadToken()
		s.mu.Lock()
		login := s.login
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"configured": err == nil, "login": login, "store": keyringStore()})
	case http.MethodPost:
		var req struct {
			Token string `json:"token"`
		}
		if !decode(w, r, &req) {
			return
		}
		token := strings.TrimSpace(req.Token)
		if token == "" {
			badRequest(w, "pegá el token")
			return
		}
		login, err := newGitHub(token).whoami()
		if err != nil {
			badRequest(w, "no guardé el token: "+err.Error())
			return
		}
		if err := keyringSet(tokenName, token); err != nil {
			badRequest(w, err.Error())
			return
		}
		s.mu.Lock()
		s.login = login
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"configured": true, "login": login})
	case http.MethodDelete:
		if err := keyringDelete(tokenName); err != nil {
			badRequest(w, err.Error())
			return
		}
		s.mu.Lock()
		s.login = ""
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
	default:
		http.Error(w, "método no permitido", http.StatusMethodNotAllowed)
	}
}

// keyringStore es el nombre del llavero donde queda el token, para la página.
func keyringStore() string {
	switch runtime.GOOS {
	case "windows":
		return "Administrador de credenciales de Windows"
	case "darwin":
		return "Llavero de macOS"
	}
	return "llavero del sistema (Secret Service)"
}

// apiWorkflow agrega el chequeo de PR (GitHub Actions) al repo de la carpeta.
func (s *uiServer) apiWorkflow(w http.ResponseWriter, r *http.Request) {
	var req sendRequest
	if !decode(w, r, &req) {
		return
	}
	dir := strings.TrimSpace(req.Dir)
	if in := Inspect(dir); !in.Exists || in.InsideOf != "" {
		badRequest(w, "elegí primero la carpeta del proyecto")
		return
	}
	p, err := writeWorkflow(dir)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(p), "inspect": InspectFull(dir)})
}

// openBrowser abre la UI como ventana de aplicación si encuentra un navegador
// basado en Chromium; si no, en el navegador por defecto.
func openBrowser(url, size string) {
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
		if err := exec.Command(path, appArg, "--new-window", "--window-size="+size).Start(); err == nil {
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
