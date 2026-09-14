package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Inspection es lo que la página necesita saber de una carpeta antes de subirla.
type Inspection struct {
	Dir       string `json:"dir"`
	Exists    bool   `json:"exists"`
	IsRepo    bool   `json:"isRepo"`    // la carpeta es la raíz de un repo
	InsideOf  string `json:"insideOf"`  // raíz del repo que la contiene, si no es ella misma
	RemoteURL string `json:"remoteUrl"` // URL de origin, si ya tiene
	Summary   string `json:"summary"`
}

// samePath compara rutas como las compara el sistema: git devuelve C:/x con
// barras normales, Windows no distingue mayúsculas, y macOS usa symlinks en /var.
func samePath(a, b string) bool {
	clean := func(p string) string {
		p = filepath.Clean(filepath.FromSlash(p))
		if real, err := filepath.EvalSymlinks(p); err == nil {
			p = real
		}
		return p
	}
	a, b = clean(a), clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// Inspect mira la carpeta sin tocar nada.
func Inspect(dir string) Inspection {
	in := Inspection{Dir: dir}
	if !filepath.IsAbs(dir) {
		return in
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return in
	}
	in.Exists = true

	root, err := toplevel(dir)
	if err != nil {
		return in // carpeta común: se inicializa al subir
	}
	if !samePath(root, dir) {
		in.InsideOf = root
		return in
	}
	in.IsRepo = true
	in.RemoteURL, _ = git(dir, "remote", "get-url", "origin")
	if r, err := LoadRepo(dir); err == nil {
		in.Summary = r.Summary()
	}
	return in
}

// validRemoteURL acepta lo que git entiende como remoto: https, ssh, git@host:ruta,
// o la ruta a un repo local.
func validRemoteURL(raw string) (string, error) {
	u := strings.TrimSpace(raw)
	switch {
	case u == "":
		return "", fmt.Errorf("falta la URL del repo")
	case strings.HasPrefix(u, "https://"), strings.HasPrefix(u, "http://"), strings.HasPrefix(u, "ssh://"):
		return u, nil
	case strings.HasPrefix(u, "git@") && strings.Contains(u, ":"):
		return u, nil
	}
	if st, err := os.Stat(u); err == nil && st.IsDir() {
		return u, nil
	}
	return "", fmt.Errorf("eso no parece la URL de un repo: %s", u)
}

// Send es el flujo de un paso: la carpeta queda apuntando a url como origin y
// se sube todo lo que tenga. Si la carpeta no era un repo, la inicializa.
func Send(dir, rawURL string) (*Result, error) {
	res := &Result{}
	url, err := validRemoteURL(rawURL)
	if err != nil {
		return res, fail(codeUsage, "%s", err.Error())
	}

	in := Inspect(dir)
	switch {
	case !in.Exists:
		return res, fail(codeRepo, "esa carpeta no existe: %s", dir)
	case in.InsideOf != "":
		return res, fail(codeRepo, "esta carpeta está dentro de otro repo (%s)", in.InsideOf).
			withHint("elegí la carpeta raíz de ese repo, o una que no esté dentro de ningún otro")
	}

	flow := &Flow{}
	if !in.IsRepo {
		if out, err := flow.run(res, dir, "init", "-b", env("APUS_DEFAULT_BRANCH", "main")); err != nil {
			return res, fail(codeRepo, "no pude inicializar el repo: %s", firstLine(out))
		}
	}

	// El remoto es el que diste vos. Si la carpeta ya apuntaba a otro, se cambia
	// y se avisa.
	changed := false
	if cur, err := git(dir, "remote", "get-url", "origin"); err != nil {
		if out, err := flow.run(res, dir, "remote", "add", "origin", url); err != nil {
			return res, fail(codeRepo, "no pude agregar el remoto: %s", firstLine(out))
		}
		changed = true
	} else if cur != url {
		if out, err := flow.run(res, dir, "remote", "set-url", "origin", url); err != nil {
			return res, fail(codeRepo, "no pude cambiar el remoto: %s", firstLine(out))
		}
		res.Note = "origin antes apuntaba a " + cur
		changed = true
	}

	repo, err := LoadRepo(dir)
	if err != nil {
		return res, fail(codeRepo, "%s", err.Error())
	}
	if !repo.Dirty() && !repo.HasHead {
		return res, fail(codeRepo, "la carpeta está vacía: no hay nada para subir")
	}

	// Con un remoto nuevo, lo que diga el seguimiento viejo no sirve: se publica
	// la rama contra origin sí o sí.
	if changed || (repo.Upstream != "" && !strings.HasPrefix(repo.Upstream, "origin/")) {
		repo.Upstream, repo.Ahead = "", 0
	}
	repo.Remote = "origin"

	pushed, err := flow.Push(repo, "")
	pushed.Steps = append(res.Steps, pushed.Steps...)
	pushed.Note = res.Note
	if f, ok := err.(*Fail); ok && f.Code == codePush && strings.Contains(f.Hint, "commits que vos no tenés") {
		f.Hint = "el repo remoto ya tiene archivos (¿lo creaste con un README?): crealo vacío, o traé esos cambios con git pull"
	}
	return pushed, err
}
