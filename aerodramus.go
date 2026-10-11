package main

import (
	_ "embed"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Aerodramus es el panel de los hallazgos de apus-guard: lee el log de la
// máquina y deja abrir cada uno en el editor, copiar el arreglo, marcarlo como
// resuelto o ignorarlo. No frena nada; solo ayuda a ordenar lo encontrado.
//
// Es otra app (su nombre, su ícono, su ventana, su acceso), pero sale del
// mismo binario: si el ejecutable se llama aerodramus.exe, arranca Aerodramus.
// Así se instala con la misma descarga y el log lo escribe un solo código.

//go:embed ui/aerodramus.html
var aeroHTML []byte

//go:embed assets/aerodramus.ico
var aeroIcon []byte

//go:embed assets/aerodramus.png
var aeroPNG []byte

// isAerodramus dice si este ejecutable es Aerodramus, por su nombre.
func isAerodramus() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return strings.HasPrefix(strings.ToLower(filepath.Base(exe)), "aerodramus")
}

func cmdAerodramus(args []string) int {
	port, portSet := 7374, false
	open := true
	autoQuit := guiMode()
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
		case "--no-open":
			open = false
		case "--quit-on-close":
			autoQuit = true
		case "-q", "--quiet":
			quiet = true
		default:
			return dieMsg(codeUsage, "opción desconocida: "+args[i], "uso: aerodramus [--port N] [--no-open]")
		}
	}
	srv := newUIServer("aerodramus", aeroHTML, aeroIcon, autoQuit)
	return srv.serve(port, portSet, open, "820,780", func(mux *http.ServeMux) {
		mux.HandleFunc("/api/findings", srv.guard(srv.aeroFindings))
		mux.HandleFunc("/api/status", srv.guard(srv.aeroStatus))
		mux.HandleFunc("/api/open", srv.guard(srv.aeroOpen))
	})
}

// aeroRepo es un repo con sus hallazgos, para la página.
type aeroRepo struct {
	Path    string   `json:"path"`
	Name    string   `json:"name"`
	Remote  string   `json:"remote,omitempty"`
	Exists  bool     `json:"exists"`
	Entries []*Entry `json:"entries"`
}

func (s *uiServer) aeroFindings(w http.ResponseWriter, r *http.Request) {
	l, err := loadLedger()
	if err != nil {
		badRequest(w, "no pude leer el log de apus-guard: "+err.Error())
		return
	}
	var repos []*aeroRepo
	counts := map[string]int{statusPending: 0, statusResolved: 0, statusIgnored: 0}
	for _, e := range sortedEntries(l.Entries) {
		counts[e.Status]++
		n := len(repos)
		if n == 0 || !sameRepo(repos[n-1].Path, e.Repo) {
			_, err := os.Stat(e.Repo)
			repos = append(repos, &aeroRepo{Path: e.Repo, Name: filepath.Base(e.Repo), Exists: err == nil})
			n++
		}
		if e.Remote != "" {
			repos[n-1].Remote = e.Remote
		}
		repos[n-1].Entries = append(repos[n-1].Entries, e)
	}
	if repos == nil {
		repos = []*aeroRepo{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": repos, "counts": counts, "log": ledgerPath()})
}

type aeroRequest struct {
	Repo   string `json:"repo"`
	ID     string `json:"id"`
	Status string `json:"status"`
}

func (s *uiServer) aeroStatus(w http.ResponseWriter, r *http.Request) {
	var req aeroRequest
	if !decode(w, r, &req) {
		return
	}
	e, err := setStatus(req.Repo, req.ID, req.Status)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *uiServer) aeroOpen(w http.ResponseWriter, r *http.Request) {
	var req aeroRequest
	if !decode(w, r, &req) {
		return
	}
	l, err := loadLedger()
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	for _, e := range l.Entries {
		if e.ID != req.ID || !sameRepo(e.Repo, req.Repo) {
			continue
		}
		path, err := entryPath(e)
		if err != nil {
			badRequest(w, err.Error())
			return
		}
		how, err := openAt(path, e.Line)
		if err != nil {
			badRequest(w, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"how": how})
		return
	}
	badRequest(w, "ese hallazgo ya no está en el log")
}

// entryPath arma la ruta del archivo de un hallazgo, sin dejar que salga del
// repo (el log es un archivo: no se confía en que nadie lo haya tocado).
func entryPath(e *Entry) (string, error) {
	repo := filepath.Clean(e.Repo)
	path := filepath.Join(repo, filepath.FromSlash(e.File))
	rel, err := filepath.Rel(repo, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(e.File) {
		return "", errors.New("la ruta del hallazgo sale del repo: no la abro")
	}
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("el archivo ya no está: %s", filepath.ToSlash(e.File))
	}
	return path, nil
}

// openAt abre un archivo en una línea. Con VS Code va a la línea exacta; si
// no está, se abre con el programa de siempre.
func openAt(path string, line int) (string, error) {
	var candidates []string
	if runtime.GOOS == "windows" {
		candidates = append(candidates,
			filepath.Join(os.Getenv("LOCALAPPDATA"), `Programs\Microsoft VS Code\Code.exe`),
			filepath.Join(os.Getenv("ProgramFiles"), `Microsoft VS Code\Code.exe`))
	}
	if p, err := exec.LookPath("code"); err == nil {
		candidates = append(candidates, p)
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err != nil {
			continue
		}
		cmd := exec.Command(c, "--goto", fmt.Sprintf("%s:%d", path, line))
		noConsole(cmd)
		if cmd.Start() == nil {
			go cmd.Wait()
			return fmt.Sprintf("se abrió en VS Code, en la línea %d", line), nil
		}
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	noConsole(cmd)
	if err := cmd.Start(); err != nil {
		return "", errors.New("no pude abrir el archivo: " + firstLine(err.Error()))
	}
	go cmd.Wait()
	return fmt.Sprintf("se abrió con el programa predeterminado: andá a la línea %d", line), nil
}

// apiAerodramus abre Aerodramus desde la ventana de apus: el mismo ejecutable,
// con el comando aerodramus.
func (s *uiServer) apiAerodramus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "solo POST", http.StatusMethodNotAllowed)
		return
	}
	exe, err := os.Executable()
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	cmd := exec.Command(exe, "aerodramus", "--quit-on-close")
	noConsole(cmd)
	if err := cmd.Start(); err != nil {
		badRequest(w, "no pude abrir Aerodramus: "+firstLine(err.Error()))
		return
	}
	go cmd.Wait()
	w.WriteHeader(http.StatusNoContent)
}
