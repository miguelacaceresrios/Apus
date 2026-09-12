package main

import (
	"fmt"
	"strings"
	"time"
)

// Códigos de salida, iguales a los del apus.sh.
const (
	codeOK    = 0
	codeRepo  = 1
	codeUsage = 2
	codePush  = 3
)

// Fail es un error con código de salida y, cuando se puede, una pista de qué hacer.
type Fail struct {
	Code int
	Msg  string
	Hint string
}

func (e *Fail) Error() string { return e.Msg }

func fail(code int, format string, a ...any) *Fail {
	return &Fail{Code: code, Msg: fmt.Sprintf(format, a...)}
}

func (e *Fail) withHint(hint string) *Fail { e.Hint = hint; return e }

// Step es un comando ejecutado, para poder mostrar el registro después.
type Step struct {
	Cmd string `json:"cmd"`
	Out string `json:"out,omitempty"`
}

// Result es el desenlace de un vuelo.
type Result struct {
	Steps     []Step `json:"steps"`
	Committed bool   `json:"committed"`
	Pushed    bool   `json:"pushed"`
	Branch    string `json:"branch"`
	Target    string `json:"target"`
	URL       string `json:"url"`
	Summary   string `json:"summary"`
}

// Flow ejecuta add + commit + push. La UI y la CLI comparten esto; lo único que
// cambia es cómo informan cada paso y cómo consiguen un remoto si falta.
type Flow struct {
	DryRun bool
	// Say recibe cada paso: kind es "cmd", "out", "ok" o "warn".
	Say func(kind, text string)
	// Link se llama cuando el repo no tiene remoto. Devuelve el nombre del
	// remoto que quedó configurado. Si es nil, el vuelo falla pidiendo uno.
	Link func(r *Repo) (string, error)
}

func (f *Flow) say(kind, text string) {
	if f.Say != nil {
		f.Say(kind, text)
	}
}

// run ejecuta un git, lo registra y devuelve su salida combinada.
func (f *Flow) run(res *Result, dir string, args ...string) (string, error) {
	line := "git " + strings.Join(args, " ")
	f.say("cmd", line)
	if f.DryRun {
		res.Steps = append(res.Steps, Step{Cmd: line})
		return "", nil
	}
	out, err := gitCombined(dir, args...)
	res.Steps = append(res.Steps, Step{Cmd: line, Out: out})
	if out != "" {
		f.say("out", out)
	}
	return out, err
}

// Push es el vuelo completo. paths vacío significa "todo" (git add -A).
func (f *Flow) Push(r *Repo, message string, paths []string) (*Result, error) {
	res := &Result{Branch: r.Branch}

	if r.Detached {
		return res, fail(codeRepo, "HEAD está desprendido (detached): hacé checkout de una rama antes de volar")
	}

	// ¿Hay algo que hacer?
	if !r.Dirty() {
		if !r.HasHead {
			res.Summary = "repo vacío y sin cambios: nada que hacer"
			return res, nil
		}
		if r.Upstream != "" && r.Ahead == 0 {
			res.Summary = fmt.Sprintf("nada que hacer: árbol limpio y %s al día con %s", r.Branch, r.Upstream)
			return res, nil
		}
	}

	// ─── add + commit ───────────────────────────────────────────────────
	if r.Dirty() {
		addArgs := []string{"add", "-A"}
		if len(paths) > 0 {
			addArgs = append([]string{"add", "--"}, paths...)
		}
		if out, err := f.run(res, r.Path, addArgs...); err != nil {
			return res, fail(codeRepo, "no se pudieron preparar los cambios: %s", firstLine(out))
		}

		staged := true
		if !f.DryRun {
			checkArgs := []string{"diff", "--cached", "--quiet"}
			if len(paths) > 0 {
				checkArgs = append(append(checkArgs, "--"), paths...)
			}
			staged = !gitOK(r.Path, checkArgs...)
		}

		if !staged {
			f.say("warn", "no quedó nada preparado para commitear: salteo el commit")
		} else {
			if strings.TrimSpace(message) == "" {
				message = defaultMessage()
			}
			commitArgs := []string{"commit", "-m", message}
			if len(paths) > 0 {
				commitArgs = append(append(commitArgs, "--"), paths...)
			}
			if out, err := f.run(res, r.Path, commitArgs...); err != nil {
				return res, fail(codeRepo, "el commit falló: %s", firstLine(out)).
					withHint("si tenés hooks de pre-commit, puede que uno lo haya rechazado")
			}
			res.Committed = true
		}
	}

	if !res.Committed && !r.HasHead {
		res.Summary = "todavía no hay ningún commit para subir"
		return res, nil
	}

	// ─── push ───────────────────────────────────────────────────────────
	var pushArgs []string
	if r.Upstream != "" {
		res.Target = r.Upstream
		pushArgs = []string{"push"}
	} else {
		remote := r.Remote
		if remote == "" {
			remote = defaultRemote(r.Path)
		}
		if remote == "" {
			names := remoteNames(r.Path)
			// Si pidieron un remoto por nombre, el problema es ese y no otro.
			if pref := env("APUS_REMOTE", ""); pref != "" {
				return res, fail(codeRepo, "APUS_REMOTE apunta a '%s', que no es un remoto de este repo", pref).
					withHint("los que hay: " + strings.Join(names, ", "))
			}
			// Con varios remotos hay que elegir, no agregar otro.
			if len(names) > 1 {
				return res, fail(codeRepo, "hay varios remotos (%s) y ninguno se llama origin", strings.Join(names, ", ")).
					withHint("elegí uno con APUS_REMOTE=<remoto>")
			}
			if f.Link == nil {
				return res, fail(codeRepo, "este repo no tiene remoto configurado").
					withHint("corré 'apus --link' para elegirlo, o 'git remote add origin <url>'")
			}
			var err error
			remote, err = f.Link(r)
			if err != nil {
				return res, err
			}
			r.Remote = remote
		}
		res.Target = remote + "/" + r.Branch
		pushArgs = []string{"push", "-u", remote, r.Branch}
	}

	out, err := f.run(res, r.Path, pushArgs...)
	if err != nil {
		e := fail(codePush, "el push falló: %s → %s", r.Branch, res.Target)
		switch {
		case strings.Contains(out, "fetch first"),
			strings.Contains(out, "non-fast-forward"),
			strings.Contains(out, "[rejected]"):
			e.Hint = "el remoto tiene commits que vos no tenés: corré 'git pull --rebase' y volvé a intentar"
		case strings.Contains(out, "Authentication failed"),
			strings.Contains(out, "Permission denied"),
			strings.Contains(out, "could not read Username"):
			e.Hint = "problema de credenciales: probá 'gh auth login' o configurá tu clave SSH"
		}
		return res, e
	}
	res.Pushed = true

	if r.Remote != "" {
		if url, _ := git(r.Path, "remote", "get-url", r.Remote); url != "" {
			res.URL = browseURL(url)
		}
	}
	if f.DryRun {
		res.Summary = fmt.Sprintf("dry-run: nada se ejecutó (%s → %s)", r.Branch, res.Target)
	} else {
		res.Summary = fmt.Sprintf("%s → %s", r.Branch, res.Target)
	}
	return res, nil
}

// defaultMessage arma el mensaje autogenerado a partir de la plantilla.
func defaultMessage() string {
	tpl := env("APUS_MESSAGE_TEMPLATE", "chore: actualización {date}")
	stamp := strftime(env("APUS_DATE_FORMAT", "%Y-%m-%d %H:%M"), time.Now())
	return strings.ReplaceAll(tpl, "{date}", stamp)
}

// strftime traduce los formatos de date(1) que se usan en la plantilla, para
// que APUS_DATE_FORMAT signifique lo mismo acá que en apus.sh.
func strftime(format string, t time.Time) string {
	var b strings.Builder
	for i := 0; i < len(format); i++ {
		if format[i] != '%' || i+1 >= len(format) {
			b.WriteByte(format[i])
			continue
		}
		i++
		switch format[i] {
		case 'Y':
			fmt.Fprintf(&b, "%04d", t.Year())
		case 'y':
			fmt.Fprintf(&b, "%02d", t.Year()%100)
		case 'm':
			fmt.Fprintf(&b, "%02d", int(t.Month()))
		case 'd':
			fmt.Fprintf(&b, "%02d", t.Day())
		case 'H':
			fmt.Fprintf(&b, "%02d", t.Hour())
		case 'I':
			h := t.Hour() % 12
			if h == 0 {
				h = 12
			}
			fmt.Fprintf(&b, "%02d", h)
		case 'M':
			fmt.Fprintf(&b, "%02d", t.Minute())
		case 'S':
			fmt.Fprintf(&b, "%02d", t.Second())
		case 'p':
			if t.Hour() < 12 {
				b.WriteString("AM")
			} else {
				b.WriteString("PM")
			}
		case 'a':
			b.WriteString(t.Format("Mon"))
		case 'A':
			b.WriteString(t.Format("Monday"))
		case 'b':
			b.WriteString(t.Format("Jan"))
		case 'B':
			b.WriteString(t.Format("January"))
		case 'Z':
			b.WriteString(t.Format("MST"))
		case 'F':
			b.WriteString(t.Format("2006-01-02"))
		case 'T':
			b.WriteString(t.Format("15:04:05"))
		case 's':
			fmt.Fprintf(&b, "%d", t.Unix())
		case '%':
			b.WriteByte('%')
		default:
			b.WriteByte('%')
			b.WriteByte(format[i])
		}
	}
	return b.String()
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return s[:i]
	}
	if s == "" {
		return "sin detalle"
	}
	return s
}
