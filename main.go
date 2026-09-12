package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

const version = "1.2.0"

var (
	quiet  bool
	stdin  = bufio.NewReader(os.Stdin)
	colors = wantColors()
)

func wantColors() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	return isTerminal(os.Stderr)
}

func paint(code, s string) string {
	if !colors {
		return s
	}
	return "\033[" + code + "m" + s + "\033[0m"
}

func step(s string) {
	if !quiet {
		fmt.Fprintln(os.Stderr, paint("2", "» "+s))
	}
}

func raw(s string) {
	if !quiet && s != "" {
		fmt.Fprintln(os.Stderr, s)
	}
}

func okMsg(s string) {
	if !quiet {
		fmt.Fprintln(os.Stderr, paint("32", "✔")+" "+s)
	}
}

func note(s string) {
	if !quiet && s != "" {
		fmt.Fprintln(os.Stderr, paint("2", "  "+s))
	}
}

func warnMsg(s string) {
	fmt.Fprintln(os.Stderr, paint("33", "!")+" "+s)
}

// dieMsg imprime el error y devuelve el código de salida.
func dieMsg(code int, msg, hint string) int {
	fmt.Fprintln(os.Stderr, paint("31", "✖")+" "+msg)
	if hint != "" {
		note(hint)
	}
	return code
}

func dieErr(err error) int {
	if f, ok := err.(*Fail); ok {
		return dieMsg(f.Code, f.Msg, f.Hint)
	}
	return dieMsg(codeRepo, err.Error(), "")
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

const usageText = `apus — add + commit + push en un solo vuelo.

USO
  apus [opciones] [mensaje]
  apus ui [--port N] [--dir RUTA]     interfaz visual en el navegador
  apus status [--json] [--dir RUTA]   estado de tus repos

OPCIONES
  -m, --message <msg>   Mensaje de commit (igual que el argumento posicional).
  -l, --link            Elegir/cambiar el repo remoto antes de subir.
  -n, --dry-run         Muestra los comandos sin ejecutar nada.
  -q, --quiet           Silencia la salida de apus.
  -h, --help            Esta ayuda.
  -V, --version         Versión.

MENSAJE
  Sin mensaje, apus lo genera desde la plantilla por defecto:
      chore: actualización {date}

VINCULACIÓN
  Si la carpeta no es un repo, apus ofrece iniciarlo. Si el repo no tiene
  remoto (o si pasás --link), apus te deja elegir uno de los repos de tu
  cuenta de GitHub (necesita 'gh' con sesión), crear uno nuevo, o pegar una
  URL / usuario/repo. Después publica la rama con 'git push -u origin <rama>'.

VARIABLES DE ENTORNO
  APUS_MESSAGE_TEMPLATE   plantilla del mensaje; {date} se reemplaza por la fecha.
  APUS_DATE_FORMAT        formato de fecha estilo date(1) (por defecto '%Y-%m-%d %H:%M').
  APUS_REMOTE             remoto a usar cuando la rama no tiene upstream.
  APUS_DEFAULT_BRANCH     rama inicial al hacer 'git init' (por defecto 'main').
  APUS_REPOS_DIR          carpetas donde buscar repos para 'apus ui' y 'apus status'.
  NO_COLOR                salida sin colores.

CÓDIGOS DE SALIDA
  0  todo bien (incluye "no había nada que hacer")
  1  error de repo (HEAD desprendido, commit rechazado, vinculación cancelada)
  2  uso incorrecto
  3  el push falló`

func printUsage() {
	os.Stdout.WriteString(usageText + "\n")
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "ui":
			return cmdUI(args[1:])
		case "status":
			return cmdStatus(args[1:])
		case "help":
			printUsage()
			return codeOK
		case "version":
			fmt.Printf("apus %s\n", version)
			return codeOK
		}
	}

	var (
		message    string
		messageSet bool
		link       bool
		dryRun     bool
		rest       []string
	)

	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			rest = append(rest, args[i+1:]...)
			break
		}
		if len(a) > 1 && strings.HasPrefix(a, "-") {
			switch {
			case a == "-m" || a == "--message":
				if i+1 >= len(args) {
					return dieMsg(codeUsage, "-m necesita un mensaje", "")
				}
				i++
				message, messageSet = args[i], true
			case strings.HasPrefix(a, "--message="):
				message, messageSet = strings.TrimPrefix(a, "--message="), true
			case a == "-l" || a == "--link":
				link = true
			case a == "-n" || a == "--dry-run":
				dryRun = true
			case a == "-q" || a == "--quiet":
				quiet = true
			case a == "-h" || a == "--help":
				printUsage()
				return codeOK
			case a == "-V" || a == "--version":
				fmt.Printf("apus %s\n", version)
				return codeOK
			default:
				return dieMsg(codeUsage, "opción desconocida: "+a, "probá 'apus --help'")
			}
			continue
		}
		rest = append(rest, args[i:]...)
		break
	}

	if len(rest) > 0 {
		if messageSet {
			return dieMsg(codeUsage, "mensaje duplicado: usá -m o el argumento posicional, no ambos", "")
		}
		message, messageSet = rest[0], true
		if len(rest) > 1 {
			return dieMsg(codeUsage, "demasiados argumentos: '"+rest[1]+"'", "¿le faltan comillas al mensaje?")
		}
	}
	_ = messageSet

	cwd, err := os.Getwd()
	if err != nil {
		return dieMsg(codeRepo, "no pude leer el directorio actual: "+err.Error(), "")
	}

	// ¿Es un repo? Si no, ofrecemos iniciarlo.
	if !gitOK(cwd, "rev-parse", "--is-inside-work-tree") {
		if !canPrompt() {
			return dieMsg(codeRepo, "esto no es un repositorio git: "+cwd, "")
		}
		warnMsg("esto no es un repositorio git: " + cwd)
		yes, err := confirm("¿lo inicializo acá?", true)
		if err != nil || !yes {
			return dieMsg(codeRepo, "listo, no toco nada", "")
		}
		branch := env("APUS_DEFAULT_BRANCH", "main")
		step("git init -b " + branch)
		if dryRun {
			okMsg("dry-run: todo lo demás depende de ese init")
			return codeOK
		}
		if out, err := gitCombined(cwd, "init", "-b", branch); err != nil {
			if out2, err2 := gitCombined(cwd, "init"); err2 != nil {
				return dieMsg(codeRepo, "no se pudo inicializar el repo: "+firstLine(out+out2), "")
			}
		}
	}

	repo, err := LoadRepo(cwd)
	if err != nil {
		return dieMsg(codeRepo, err.Error(), "")
	}

	if link {
		if !canPrompt() {
			return dieMsg(codeRepo, "--link necesita una terminal interactiva", "")
		}
		if _, err := linkInteractive(repo, dryRun); err != nil {
			return dieErr(err)
		}
		// Después de vincular, el estado cambió: lo volvemos a leer.
		if fresh, err := LoadRepo(repo.Path); err == nil {
			fresh.Files = repo.Files
			repo = fresh
		}
	}

	flow := &Flow{
		DryRun: dryRun,
		Say: func(kind, text string) {
			switch kind {
			case "cmd":
				step(text)
			case "out":
				raw(text)
			case "warn":
				warnMsg(text)
			}
		},
	}
	if canPrompt() {
		flow.Link = func(r *Repo) (string, error) {
			warnMsg("este repo todavía no tiene remoto")
			return linkInteractive(r, dryRun)
		}
	}

	res, err := flow.Push(repo, message, nil)
	if err != nil {
		return dieErr(err)
	}
	okMsg(res.Summary)
	note(res.URL)
	return codeOK
}

// confirm hace una pregunta de sí/no en la terminal.
func confirm(question string, def bool) (bool, error) {
	hint := "s/n"
	if def {
		hint = "S/n"
	} else {
		hint = "s/N"
	}
	line, err := ask(fmt.Sprintf("%s (%s)", question, hint), "")
	if err != nil {
		return false, err
	}
	line = strings.ToLower(strings.TrimSpace(line))
	if line == "" {
		return def, nil
	}
	return strings.HasPrefix(line, "s") || strings.HasPrefix(line, "y"), nil
}

// ask escribe la pregunta en stderr y lee una línea de stdin.
func ask(question, def string) (string, error) {
	prompt := paint("1", "?") + " " + question
	if def != "" {
		prompt += " " + paint("2", "["+def+"]")
	}
	fmt.Fprint(os.Stderr, prompt+": ")
	line, err := stdin.ReadString('\n')
	if err != nil && line == "" {
		fmt.Fprintln(os.Stderr)
		return "", fail(codeRepo, "no hay nadie del otro lado para responder")
	}
	line = strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(line) == "" {
		return def, nil
	}
	return line, nil
}
