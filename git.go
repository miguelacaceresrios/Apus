package main

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// git corre un comando y devuelve su stdout ya limpio. El error trae el stderr,
// que es lo que le sirve a quien lo lee.
func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	noConsole(cmd)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	stdout := strings.TrimRight(out.String(), "\r\n")
	if err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout, errors.New(msg)
	}
	return stdout, nil
}

// gitCombined corre git y devuelve stdout+stderr juntos, como los ve el usuario.
func gitCombined(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	noConsole(cmd)
	out, err := cmd.CombinedOutput()
	return strings.TrimRight(string(out), "\r\n"), err
}

func gitOK(dir string, args ...string) bool {
	_, err := git(dir, args...)
	return err == nil
}

// FileChange es una línea de `git status --porcelain`.
type FileChange struct {
	Index  string `json:"index"`  // estado en el índice (staged)
	Work   string `json:"work"`   // estado en el árbol de trabajo
	Path   string `json:"path"`   // ruta relativa al toplevel
	Origin string `json:"origin"` // ruta anterior, si hubo rename
}

// Repo es la foto de un repositorio en un momento dado.
type Repo struct {
	Path      string       `json:"path"`   // toplevel
	Name      string       `json:"name"`   // nombre de la carpeta
	Branch    string       `json:"branch"` // vacío si HEAD está desprendido
	Detached  bool         `json:"detached"`
	HasHead   bool         `json:"hasHead"` // ya tiene al menos un commit
	Upstream  string       `json:"upstream"`
	Remote    string       `json:"remote"`    // nombre del remoto (origin, …)
	RemoteURL string       `json:"remoteUrl"` // URL del remoto elegido
	Ahead     int          `json:"ahead"`
	Files     []FileChange `json:"files"`
}

func (r *Repo) Dirty() bool { return len(r.Files) > 0 }

// Summary es la línea de estado que se muestra en las listas.
func (r *Repo) Summary() string {
	var parts []string
	if n := len(r.Files); n == 1 {
		parts = append(parts, "1 cambio")
	} else if n > 1 {
		parts = append(parts, fmt.Sprintf("%d cambios", n))
	}
	if r.Ahead == 1 {
		parts = append(parts, "1 commit sin subir")
	} else if r.Ahead > 1 {
		parts = append(parts, fmt.Sprintf("%d commits sin subir", r.Ahead))
	}
	if r.HasHead && r.Upstream == "" {
		// Ojo con la diferencia: no es lo mismo no tener a dónde subir que
		// tener remoto y no haber publicado la rama todavía.
		if r.RemoteURL == "" {
			parts = append(parts, "sin remoto")
		} else {
			parts = append(parts, "rama sin publicar")
		}
	}
	if len(parts) == 0 {
		if !r.HasHead {
			return "vacío"
		}
		return "al día"
	}
	return strings.Join(parts, ", ")
}

// toplevel devuelve la raíz del repo que contiene a dir.
func toplevel(dir string) (string, error) {
	out, err := git(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return filepath.Clean(out), nil
}

// LoadRepo arma la foto del repo cuyo árbol de trabajo contiene a dir.
func LoadRepo(dir string) (*Repo, error) {
	root, err := toplevel(dir)
	if err != nil {
		return nil, fmt.Errorf("esto no es un repositorio git: %s", dir)
	}
	if bare, _ := git(root, "rev-parse", "--is-bare-repository"); bare == "true" {
		return nil, fmt.Errorf("el repositorio es bare: no hay árbol de trabajo que subir")
	}

	r := &Repo{Path: root, Name: filepath.Base(root)}
	if branch, err := git(root, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		r.Branch = branch
	} else {
		r.Detached = true
	}
	r.HasHead = gitOK(root, "rev-parse", "--verify", "--quiet", "HEAD")

	if up, err := git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
		r.Upstream = up
		r.Remote, _, _ = strings.Cut(up, "/")
		if r.HasHead {
			if counts, err := git(root, "rev-list", "--left-right", "--count", up+"...HEAD"); err == nil {
				if fields := strings.Fields(counts); len(fields) == 2 {
					r.Ahead, _ = strconv.Atoi(fields[1])
				}
			}
		}
	}
	if r.Remote == "" {
		r.Remote = defaultRemote(root)
	}
	if r.Remote != "" {
		r.RemoteURL, _ = git(root, "remote", "get-url", r.Remote)
	}

	r.Files, err = statusFiles(root)
	if err != nil {
		return nil, err
	}
	return r, nil
}

// defaultRemote elige el remoto a usar cuando la rama no tiene upstream:
// APUS_REMOTE, si no origin, si no el único que haya.
func defaultRemote(root string) string {
	out, err := git(root, "remote")
	if err != nil {
		return ""
	}
	var remotes []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			remotes = append(remotes, line)
		}
	}
	if pref := env("APUS_REMOTE", ""); pref != "" {
		for _, r := range remotes {
			if r == pref {
				return pref
			}
		}
		return ""
	}
	for _, r := range remotes {
		if r == "origin" {
			return "origin"
		}
	}
	if len(remotes) == 1 {
		return remotes[0]
	}
	return ""
}

func remoteNames(root string) []string {
	out, _ := git(root, "remote")
	var remotes []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			remotes = append(remotes, line)
		}
	}
	return remotes
}

// statusFiles parsea `git status --porcelain -z`, que separa con NUL y no
// escapa nada: los nombres con espacios o acentos llegan tal cual.
func statusFiles(root string) ([]FileChange, error) {
	out, err := git(root, "status", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	var files []FileChange
	entries := strings.Split(out, "\x00")
	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if len(e) < 4 {
			continue
		}
		fc := FileChange{Index: string(e[0]), Work: string(e[1]), Path: e[3:]}
		// En un rename, la ruta vieja viene en la entrada siguiente.
		if fc.Index == "R" || fc.Work == "R" {
			if i+1 < len(entries) {
				fc.Origin = entries[i+1]
				i++
			}
		}
		files = append(files, fc)
	}
	return files, nil
}

// browseURL convierte la URL de un remoto en algo que se pueda abrir en el
// navegador; devuelve "" si no es una URL http/ssh (por ejemplo, una ruta local).
func browseURL(remote string) string {
	u := strings.TrimSpace(remote)
	switch {
	case strings.HasPrefix(u, "git@") && strings.Contains(u, ":"):
		host, path, _ := strings.Cut(strings.TrimPrefix(u, "git@"), ":")
		u = "https://" + host + "/" + path
	case strings.HasPrefix(u, "ssh://git@"):
		u = "https://" + strings.TrimPrefix(u, "ssh://git@")
	case strings.HasPrefix(u, "http://"), strings.HasPrefix(u, "https://"):
		// tal cual
	default:
		return ""
	}
	return strings.TrimSuffix(u, ".git")
}
