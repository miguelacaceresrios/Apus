package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Cuando GitHub rechaza el push porque tiene commits que la carpeta no tiene,
// "Subir" no se queda en el error: trae lo del remoto, ensaya el merge sin
// tocar la carpeta (git merge-tree) y ofrece la salida que corresponda.

// Motivos de la ventana, además de los de la terminal (flow.go).
const (
	reasonSecrets   = "secrets"   // apus-guard frenó la subida
	reasonDiverged  = "diverged"  // el remoto tiene commits que la carpeta no tiene
	reasonConflicts = "conflicts" // a mitad de traer cambios, con archivos por resolver
)

// Divergence es lo que la ventana necesita para ofrecer una salida.
type Divergence struct {
	Branch string `json:"branch"`
	// Lease es el commit del remoto que se analizó: el force push solo pisa
	// ese, y si GitHub cambió mientras tanto, no pisa nada.
	Lease     string   `json:"lease,omitempty"`
	Unrelated bool     `json:"unrelated"`           // sin historia en común (el repo se creó con README)
	Incoming  []string `json:"incoming"`            // archivos que trae el remoto
	More      int      `json:"more,omitempty"`      // entrantes que no entraron en la lista
	Conflicts []string `json:"conflicts"`           // archivos que chocan
	Behind    int      `json:"behind"`              // commits que tiene el remoto y la carpeta no
	Ahead     int      `json:"ahead"`               // commits de la carpeta que el remoto no tiene
	Rebasing  bool     `json:"rebasing,omitempty"`  // quedó a mitad de traer cambios
	Markers   []string `json:"markers,omitempty"`   // archivos que todavía tienen <<<<<<<
	Operation string   `json:"operation,omitempty"` // rebase o merge, si quedó a mitad
}

// Trivial dice si se puede traer y seguir sin preguntar nada más.
func (d *Divergence) Trivial() bool { return len(d.Conflicts) == 0 }

func gitCode(dir string, args ...string) (string, int, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	noConsole(cmd)
	out, err := cmd.Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return string(out), exit.ExitCode(), nil
	}
	return string(out), 0, err
}

func nonEmpty(out string) []string {
	var r []string
	seen := map[string]bool{}
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		if l = strings.TrimSpace(l); l != "" && !seen[l] {
			seen[l] = true
			r = append(r, l)
		}
	}
	return r
}

const maxIncoming = 30

// analyze trae la rama del remoto y ve qué pasaría al juntarla con la local.
func (f *Flow) analyze(res *Result, dir, branch string) (*Divergence, error) {
	if out, err := f.run(res, dir, "fetch", "origin", branch); err != nil {
		e := fail(codePush, "no pude traer lo que tiene GitHub: %s", firstLine(out))
		e.Reason, e.Hint = pushTrouble(out)
		return nil, e
	}
	sha, err := git(dir, "rev-parse", "FETCH_HEAD")
	if err != nil {
		return nil, fail(codePush, "no pude leer lo que traje de GitHub: %s", firstLine(err.Error()))
	}
	d := &Divergence{Branch: branch, Lease: sha, Incoming: []string{}, Conflicts: []string{}}
	d.Unrelated = !gitOK(dir, "merge-base", "HEAD", sha)

	// El ensayo: merge-tree calcula el merge en memoria. 0 es limpio, 1 es con
	// conflictos (y la lista viene después del árbol).
	args := []string{"merge-tree", "--write-tree", "--name-only", "--no-messages"}
	if d.Unrelated {
		args = append(args, "--allow-unrelated-histories")
	}
	out, code, err := gitCode(dir, append(args, "HEAD", sha)...)
	switch {
	case err != nil || code > 1:
		return nil, fail(codePush, "no pude ensayar el merge con lo de GitHub (hace falta git 2.38 o más nuevo)")
	case code == 1:
		if lines := nonEmpty(out); len(lines) > 1 {
			d.Conflicts = lines[1:]
		}
	}

	if d.Unrelated {
		out, _ = git(dir, "ls-tree", "-r", "--name-only", sha)
		d.Ahead = revCount(dir, "HEAD")
		d.Behind = revCount(dir, sha)
	} else {
		out, _ = git(dir, "diff", "--name-only", "HEAD..."+sha)
		if counts, err := git(dir, "rev-list", "--left-right", "--count", "HEAD..."+sha); err == nil {
			if f := strings.Fields(counts); len(f) == 2 {
				d.Ahead, _ = strconv.Atoi(f[0])
				d.Behind, _ = strconv.Atoi(f[1])
			}
		}
	}
	d.Incoming = nonEmpty(out)
	if len(d.Incoming) > maxIncoming {
		d.More = len(d.Incoming) - maxIncoming
		d.Incoming = d.Incoming[:maxIncoming]
	}
	return d, nil
}

func revCount(dir, rev string) int {
	out, _ := git(dir, "rev-list", "--count", rev)
	n, _ := strconv.Atoi(strings.TrimSpace(out))
	return n
}

// ─── a mitad de traer cambios ───────────────────────────────────────────────

func gitPath(dir, name string) string {
	p, err := git(dir, "rev-parse", "--git-path", name)
	if err != nil {
		return ""
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return p
}

// pending dice si la carpeta quedó a mitad de un rebase o un merge.
func pending(dir string) string {
	for _, c := range []struct{ path, op string }{{"rebase-merge", "rebase"}, {"rebase-apply", "rebase"}, {"MERGE_HEAD", "merge"}} {
		if p := gitPath(dir, c.path); p != "" {
			if _, err := os.Stat(p); err == nil {
				return c.op
			}
		}
	}
	return ""
}

// pendingBranch es la rama sobre la que se estaba trabajando: durante un
// rebase HEAD queda desprendido.
func pendingBranch(dir string) string {
	for _, name := range []string{"rebase-merge/head-name", "rebase-apply/head-name"} {
		if data, err := os.ReadFile(gitPath(dir, name)); err == nil {
			return strings.TrimPrefix(strings.TrimSpace(string(data)), "refs/heads/")
		}
	}
	b, _ := git(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	return b
}

// hasMarkers dice si a un archivo le quedan marcas de conflicto.
func hasMarkers(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4<<20)
	for sc.Scan() {
		l := sc.Text()
		if strings.HasPrefix(l, "<<<<<<< ") || strings.HasPrefix(l, ">>>>>>> ") {
			return true
		}
	}
	return false
}

// conflictState describe la carpeta a mitad de traer cambios, o nil si no lo está.
func conflictState(dir string) *Divergence {
	op := pending(dir)
	if op == "" {
		return nil
	}
	out, _ := git(dir, "diff", "--name-only", "--diff-filter=U")
	d := &Divergence{Branch: pendingBranch(dir), Rebasing: true, Operation: op, Incoming: []string{}, Conflicts: nonEmpty(out)}
	for _, c := range d.Conflicts {
		if hasMarkers(filepath.Join(dir, filepath.FromSlash(c))) {
			d.Markers = append(d.Markers, c)
		}
	}
	return d
}

func conflictFail(d *Divergence) *Fail {
	msg := "quedan archivos en conflicto: resolvelos y tocá Continuar"
	if len(d.Conflicts) == 0 {
		msg = "quedaste a mitad de traer los cambios de GitHub: tocá Continuar o Cancelar"
	}
	return fail(codePush, "%s", msg).withReason(reasonConflicts)
}

// ─── las salidas ────────────────────────────────────────────────────────────

func (f *Flow) finishPush(res *Result, dir, branch string, extra ...string) (*Result, error) {
	args := append([]string{"push"}, extra...)
	args = append(args, "-u", "origin", branch)
	out, err := f.run(res, dir, args...)
	if err != nil {
		e := fail(codePush, "el push falló: %s → origin/%s", branch, branch)
		e.Reason, e.Hint = pushTrouble(out)
		if strings.Contains(out, "stale info") {
			e.Reason = reasonDiverged
			e.Msg = "GitHub cambió mientras decidías: no sobrescribí nada"
			e.Hint = "tocá Subir de nuevo para ver qué hay ahora"
		} else if e.Reason == reasonBehind {
			// Alguien subió algo en el medio: se vuelve a analizar.
			if d, err := f.analyze(res, dir, branch); err == nil {
				res.Divergence = d
				e.Reason = reasonDiverged
				e.Msg = "GitHub recibió cambios nuevos en el medio"
				e.Hint = ""
			}
		}
		return res, e
	}
	res.Pushed = true
	res.Branch = branch
	res.Target = "origin/" + branch
	res.Summary = fmt.Sprintf("%s → %s", branch, res.Target)
	if u, _ := git(dir, "remote", "get-url", "origin"); u != "" {
		res.URL = browseURL(u)
	}
	return res, nil
}

// Resolve aplica la salida que eligió el usuario:
//
//	pull      traer y continuar (solo sin conflictos)
//	rebase    traer los cambios del remoto con rebase; si chocan, queda a mitad
//	continue  seguir después de resolver los conflictos
//	abort     cancelar y dejar la carpeta como estaba
//	force     sobrescribir el remoto (lease: el commit que se mostró)
func Resolve(dir, action, lease string) (*Result, error) {
	res := &Result{}
	f := &Flow{}
	if !gitOK(dir, "rev-parse", "--is-inside-work-tree") {
		return res, fail(codeRepo, "esa carpeta no es un repo")
	}

	if op := pending(dir); op != "" {
		switch action {
		case "abort":
			if out, err := f.run(res, dir, op, "--abort"); err != nil {
				return res, fail(codeRepo, "no pude cancelar: %s", firstLine(out))
			}
			branch := pendingBranch(dir)
			d, err := f.analyze(res, dir, branch)
			if err != nil {
				return res, err
			}
			res.Divergence = d
			return res, fail(codePush, "listo, dejé tu carpeta como estaba").
				withHint("GitHub sigue teniendo cambios que no tenés: elegí cómo seguir").withReason(reasonDiverged)
		case "continue":
			return f.continuePending(res, dir, op)
		}
		res.Divergence = conflictState(dir)
		return res, conflictFail(res.Divergence)
	}

	branch, err := git(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return res, fail(codeRepo, "HEAD está desprendido: hacé checkout de una rama")
	}

	switch action {
	case "force":
		if lease == "" {
			return res, fail(codeUsage, "falta el commit de GitHub que se va a sobrescribir")
		}
		return f.finishPush(res, dir, branch, "--force-with-lease=refs/heads/"+branch+":"+lease)

	case "pull", "rebase":
		d, err := f.analyze(res, dir, branch)
		if err != nil {
			return res, err
		}
		if d.Behind == 0 {
			return f.finishPush(res, dir, branch)
		}
		if action == "pull" && !d.Trivial() {
			res.Divergence = d
			return res, fail(codePush, "ahora hay archivos que chocan con los de GitHub").withReason(reasonDiverged)
		}
		var out string
		if action == "pull" && d.Unrelated {
			out, err = f.run(res, dir, "merge", "--allow-unrelated-histories", "--no-edit", "-m", "merge: lo que ya tenía GitHub", d.Lease)
		} else {
			out, err = f.run(res, dir, "-c", "core.editor=true", "rebase", d.Lease)
		}
		if err != nil {
			if st := conflictState(dir); st != nil && len(st.Conflicts) > 0 {
				res.Divergence = st
				return res, conflictFail(st)
			}
			if op := pending(dir); op != "" {
				f.run(res, dir, op, "--abort")
			}
			res.Divergence = d
			return res, fail(codePush, "no pude traer los cambios: %s", firstLine(out)).withReason(reasonDiverged)
		}
		return f.finishPush(res, dir, branch)
	}
	return res, fail(codeUsage, "no conozco la acción %q", action)
}

// continuePending sigue un rebase o merge que quedó a mitad, después de que el
// usuario resolvió los conflictos en su editor.
func (f *Flow) continuePending(res *Result, dir, op string) (*Result, error) {
	st := conflictState(dir)
	if len(st.Markers) > 0 {
		res.Divergence = st
		return res, fail(codePush, "todavía hay marcas de conflicto (<<<<<<<) en %s", strings.Join(st.Markers, ", ")).
			withHint("abrilos, elegí qué queda, borrá las marcas y guardá").withReason(reasonConflicts)
	}
	if out, err := f.run(res, dir, "add", "-A"); err != nil {
		return res, fail(codeRepo, "no pude marcar los conflictos como resueltos: %s", firstLine(out))
	}
	var out string
	var err error
	if op == "rebase" {
		out, err = f.run(res, dir, "-c", "core.editor=true", "rebase", "--continue")
	} else {
		out, err = f.run(res, dir, "commit", "--no-edit")
	}
	if st := conflictState(dir); st != nil {
		// El rebase siguió con el próximo commit y ese también choca.
		res.Divergence = st
		return res, conflictFail(st)
	}
	if err != nil {
		return res, fail(codeRepo, "no pude seguir: %s", firstLine(out))
	}
	branch, err := git(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return res, fail(codeRepo, "HEAD quedó desprendido: hacé checkout de una rama")
	}
	return f.finishPush(res, dir, branch)
}
