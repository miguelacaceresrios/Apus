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
	// Findings es lo que encontró apus-guard en lo que se subiría, sin lo que
	// se marcó como ignorado en Aerodramus (Ignored cuenta cuántos).
	Findings []Finding `json:"findings"`
	Ignored  int       `json:"ignored"`
	// Pending es la carpeta a mitad de traer cambios, con sus conflictos.
	Pending *Divergence `json:"pending,omitempty"`
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
	in.Pending = conflictState(dir)
	return in
}

// InspectFull es Inspect más la revisión de apus-guard, para la ventana.
func InspectFull(dir string) Inspection {
	in := Inspect(dir)
	if in.Exists && in.InsideOf == "" {
		in.Findings, in.Ignored, _ = GuardLocal(dir, in.RemoteURL)
	}
	if in.Findings == nil {
		in.Findings = []Finding{}
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
//
// Antes de tocar nada pasa apus-guard: con un secreto crítico no se hace ni el
// init, ni el cambio de remoto, ni el commit. Y si GitHub rechaza el push
// porque tiene commits que la carpeta no tiene, devuelve el análisis para que
// la ventana ofrezca cómo seguir.
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
	case in.Pending != nil:
		res.Divergence = in.Pending
		return res, conflictFail(in.Pending)
	}

	findings, ignored, err := GuardLocal(dir, url)
	if err != nil {
		return res, fail(codeRepo, "apus-guard no pudo revisar la carpeta: %s", firstLine(err.Error()))
	}
	res.Findings, res.Ignored = findings, ignored
	if hasCritical(findings) {
		var note string
		res.Issues, note = reportSecrets(url, findings)
		res.Note = note
		if abs, err := filepath.Abs(dir); err == nil {
			recordIssues(filepath.Clean(abs), res.Issues)
		}
		n := countSeverity(findings, sevCritical)
		msg := "apus-guard frenó la subida: hay un secreto escrito en el código"
		if n > 1 {
			msg = fmt.Sprintf("apus-guard frenó la subida: hay %d secretos escritos en el código", n)
		}
		return res, fail(codeRepo, "%s", msg).
			withHint("no subí nada: sacalos del código y volvé a tocar Subir").withReason(reasonSecrets)
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
	pushed.Findings, pushed.Ignored = res.Findings, res.Ignored
	if f, ok := err.(*Fail); ok && f.Reason == reasonBehind && repo.Branch != "" {
		d, aerr := flow.analyze(pushed, repo.Path, repo.Branch)
		if aerr != nil {
			return pushed, aerr
		}
		pushed.Divergence = d
		msg := "GitHub tiene cambios que tu carpeta no tiene"
		if d.Unrelated {
			msg = "el repo de GitHub ya tiene archivos que tu carpeta no tiene"
		}
		hint := "no chocan con los tuyos: traelos y se sube todo"
		if !d.Trivial() {
			hint = "hay archivos que cambiaron en los dos lados: elegí cómo seguir"
		}
		// El commit ya quedó hecho: elegir una salida no pierde nada.
		return pushed, fail(codePush, "%s", msg).withHint(hint).withReason(reasonDiverged)
	}
	return pushed, err
}
