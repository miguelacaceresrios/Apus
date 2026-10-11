package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ─── el token ───────────────────────────────────────────────────────────────

const (
	keyringService = "apus"
	tokenName      = "github"
)

var (
	errNoSecret  = errors.New("no hay un token de GitHub guardado")
	errNoKeyring = errors.New("no hay un llavero del sistema donde guardar el token: en Linux, instalá secret-tool (libsecret-tools)")
)

// loadToken lee el token del llavero del sistema. Es una variable para que las
// pruebas no toquen el llavero de verdad.
var loadToken = func() (string, error) { return keyringGet(tokenName) }

// ─── la API ─────────────────────────────────────────────────────────────────

type ghClient struct {
	api, token string
	http       *http.Client
}

func newGitHub(token string) *ghClient {
	api := env("APUS_GITHUB_API", env("GITHUB_API_URL", "https://api.github.com"))
	return &ghClient{api: strings.TrimRight(api, "/"), token: token, http: &http.Client{Timeout: 20 * time.Second}}
}

// scrub saca el token de cualquier texto que pueda terminar en pantalla.
func (c *ghClient) scrub(s string) string {
	if c.token == "" {
		return s
	}
	return strings.ReplaceAll(s, c.token, "***")
}

type ghError struct {
	Status int
	Msg    string
}

func (e *ghError) Error() string {
	switch e.Status {
	case http.StatusUnauthorized:
		return "GitHub rechazó el token (401): revisá que no haya vencido"
	case http.StatusForbidden:
		return "el token no tiene permiso para esto (403): " + e.Msg
	case http.StatusNotFound:
		return "GitHub no encuentra el repo, o el token no lo ve (404)"
	}
	return fmt.Sprintf("GitHub respondió %d: %s", e.Status, e.Msg)
}

func (c *ghClient) do(method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.api+path, rd)
	if err != nil {
		return errors.New(c.scrub(err.Error()))
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "apus/"+version)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New("no pude hablar con GitHub: " + firstLine(c.scrub(err.Error())))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Message string `json:"message"`
		}
		json.Unmarshal(data, &e)
		return &ghError{resp.StatusCode, c.scrub(e.Message)}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// whoami valida el token y devuelve el usuario.
func (c *ghClient) whoami() (string, error) {
	var u struct {
		Login string `json:"login"`
	}
	if err := c.do("GET", "/user", nil, &u); err != nil {
		return "", err
	}
	return u.Login, nil
}

// githubRepo saca dueño y repo de la URL de un remoto de github.com.
func githubRepo(remote string) (owner, repo string, ok bool) {
	u := strings.TrimSpace(remote)
	var p string
	switch {
	case strings.HasPrefix(u, "git@github.com:"):
		p = strings.TrimPrefix(u, "git@github.com:")
	case strings.HasPrefix(u, "https://"), strings.HasPrefix(u, "http://"), strings.HasPrefix(u, "ssh://"):
		parsed, err := url.Parse(u)
		if err != nil || !strings.EqualFold(parsed.Hostname(), "github.com") {
			return "", "", false
		}
		p = parsed.Path
	default:
		return "", "", false
	}
	parts := strings.Split(strings.Trim(strings.TrimSuffix(strings.Trim(p, "/"), ".git"), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// ─── issues ─────────────────────────────────────────────────────────────────

var markerRe = regexp.MustCompile(`<!-- apus-guard:([0-9a-f]{12}) -->`)

func marker(f Finding) string { return "<!-- apus-guard:" + f.ID + " -->" }

var sevName = map[string]string{sevCritical: "Crítico", sevWarning: "Aviso"}

func fence(s string) string {
	return "~~~text\n" + strings.ReplaceAll(s, "~~~", "~ ~ ~") + "\n~~~"
}

func issueBody(f Finding) string {
	var b strings.Builder
	b.WriteString("**apus-guard** frenó una subida porque encontró un secreto escrito en el código. **El secreto no llegó a GitHub**: apus no hizo el push.\n\n")
	b.WriteString("| | |\n|---|---|\n")
	fmt.Fprintf(&b, "| Archivo | `%s` |\n| Línea | %d |\n| Severidad | %s |\n| Regla | `%s` |\n", f.File, f.Line, sevName[f.Severity], f.Rule)
	if f.Key != "" {
		fmt.Fprintf(&b, "| Clave | `%s` |\n", f.Key)
	}
	fmt.Fprintf(&b, "\n%s\n\n**Qué hacer:** %s\n\nCuando lo arregles, cerrá este issue.\n\n%s\n", fence(f.Snippet), f.Fix, marker(f))
	return b.String()
}

// IssueRef es un issue de un hallazgo: uno que ya estaba abierto, o uno nuevo.
type IssueRef struct {
	Finding string `json:"finding"`
	Number  int    `json:"number"`
	URL     string `json:"url"`
	New     bool   `json:"new"`
}

// reportIssues abre un issue por cada hallazgo crítico que no tenga ya uno
// abierto (se reconocen por la marca con el hash de archivo, línea y regla).
func reportIssues(c *ghClient, owner, repo string, fs []Finding) ([]IssueRef, error) {
	type issue struct {
		Number int       `json:"number"`
		URL    string    `json:"html_url"`
		Body   string    `json:"body"`
		PR     *struct{} `json:"pull_request"`
	}
	open := map[string]issue{}
	base := "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/issues"
	for page := 1; page <= 5; page++ {
		var list []issue
		if err := c.do("GET", base+"?state=open&per_page=100&page="+strconv.Itoa(page), nil, &list); err != nil {
			return nil, err
		}
		for _, is := range list {
			if is.PR != nil {
				continue
			}
			for _, m := range markerRe.FindAllStringSubmatch(is.Body, -1) {
				open[m[1]] = is
			}
		}
		if len(list) < 100 {
			break
		}
	}

	var out []IssueRef
	for _, f := range fs {
		if f.Severity != sevCritical {
			continue
		}
		if is, ok := open[f.ID]; ok {
			out = append(out, IssueRef{f.ID, is.Number, is.URL, false})
			continue
		}
		req := map[string]any{
			"title":  fmt.Sprintf("apus-guard: %s en %s:%d", f.Title, f.File, f.Line),
			"body":   issueBody(f),
			"labels": []string{"apus-guard"},
		}
		var created issue
		err := c.do("POST", base, req, &created)
		var ge *ghError
		if errors.As(err, &ge) && ge.Status == http.StatusUnprocessableEntity {
			delete(req, "labels") // sin permiso para etiquetas: el issue igual sirve
			err = c.do("POST", base, req, &created)
		}
		if err != nil {
			return out, err
		}
		open[f.ID] = created
		out = append(out, IssueRef{f.ID, created.Number, created.URL, true})
	}
	return out, nil
}

// reportSecrets es lo que usa "Subir" cuando apus-guard frena: si la URL es de
// GitHub y hay token, abre los issues. Es una variable para las pruebas.
var reportSecrets = func(remote string, fs []Finding) ([]IssueRef, string) {
	owner, repo, ok := githubRepo(remote)
	if !ok {
		return nil, ""
	}
	token, err := loadToken()
	if err != nil {
		if errors.Is(err, errNoSecret) {
			return nil, "con un token de GitHub en Ajustes, apus además deja esto anotado como issue en el repo"
		}
		return nil, "no abrí issues: " + err.Error()
	}
	refs, err := reportIssues(newGitHub(token), owner, repo, fs)
	if err != nil {
		return refs, "no pude abrir los issues en GitHub: " + err.Error()
	}
	return refs, ""
}

// ─── revisión de PR (GitHub Actions) ────────────────────────────────────────

func reviewBody(f Finding) string {
	title := f.Title
	if f.Key != "" {
		title += " (`" + f.Key + "`)"
	}
	return fmt.Sprintf("**apus-guard · %s**: %s\n\n%s\n\n**Qué hacer:** %s\n\n%s", sevName[f.Severity], title, fence(f.Snippet), f.Fix, marker(f))
}

// postReview comenta cada hallazgo en su línea del PR, en una sola revisión.
// Los que ya tienen comentario (de una corrida anterior) no se repiten.
func postReview(c *ghClient, owner, repo string, number int, head string, fs []Finding) (int, error) {
	base := fmt.Sprintf("/repos/%s/%s/pulls/%d", url.PathEscape(owner), url.PathEscape(repo), number)
	done := map[string]bool{}
	for page := 1; page <= 10; page++ {
		var list []struct {
			Body string `json:"body"`
		}
		if err := c.do("GET", base+"/comments?per_page=100&page="+strconv.Itoa(page), nil, &list); err != nil {
			return 0, err
		}
		for _, cm := range list {
			for _, m := range markerRe.FindAllStringSubmatch(cm.Body, -1) {
				done[m[1]] = true
			}
		}
		if len(list) < 100 {
			break
		}
	}
	type comment struct {
		Path string `json:"path"`
		Line int    `json:"line"`
		Side string `json:"side"`
		Body string `json:"body"`
	}
	var comments []comment
	for _, f := range fs {
		if !done[f.ID] {
			comments = append(comments, comment{f.File, f.Line, "RIGHT", reviewBody(f)})
		}
	}
	if len(comments) == 0 {
		return 0, nil
	}
	crit := countSeverity(fs, sevCritical)
	summary := fmt.Sprintf("apus-guard encontró %d secreto(s) en este PR", len(fs))
	if crit > 0 {
		summary += fmt.Sprintf(": %d crítico(s). El check falla hasta que salgan del código.", crit)
	} else {
		summary += ", todos avisos: el check pasa."
	}
	req := map[string]any{"commit_id": head, "event": "COMMENT", "body": summary, "comments": comments}
	return len(comments), c.do("POST", base+"/reviews", req, nil)
}

// guardPR es el modo de GitHub Actions: revisa lo que agrega el PR, comenta y
// falla si hay algo crítico.
func guardPR() int {
	var event struct {
		PullRequest struct {
			Number int `json:"number"`
			Base   struct {
				Sha string `json:"sha"`
			} `json:"base"`
			Head struct {
				Sha string `json:"sha"`
			} `json:"head"`
		} `json:"pull_request"`
	}
	data, err := os.ReadFile(os.Getenv("GITHUB_EVENT_PATH"))
	if err == nil {
		err = json.Unmarshal(data, &event)
	}
	pr := event.PullRequest
	if err != nil || pr.Number == 0 || pr.Base.Sha == "" || pr.Head.Sha == "" {
		return dieMsg(codeUsage, "apus guard --pr corre en GitHub Actions, en un evento pull_request", "")
	}
	owner, repo, _ := strings.Cut(os.Getenv("GITHUB_REPOSITORY"), "/")

	fs, err := GuardDiff(".", pr.Base.Sha, pr.Head.Sha)
	if err != nil {
		return dieMsg(codeRepo, "no pude leer el diff del PR: "+firstLine(err.Error()), "¿el checkout tiene fetch-depth: 0?")
	}
	printFindings(fs)
	for _, f := range fs {
		level := "warning"
		if f.Severity == sevCritical {
			level = "error"
		}
		// Anotación de Actions: aparece en la pestaña de archivos del PR.
		fmt.Printf("::%s file=%s,line=%d,title=apus-guard::%s\n", level, f.File, f.Line, f.Title)
	}

	if token := os.Getenv("GITHUB_TOKEN"); token != "" && owner != "" && len(fs) > 0 {
		n, err := postReview(newGitHub(token), owner, repo, pr.Number, pr.Head.Sha, fs)
		switch {
		case err != nil:
			// En un PR desde un fork el token no puede comentar: el check igual falla.
			warnMsg("no pude comentar el PR: " + err.Error())
		case n > 0:
			okMsg(fmt.Sprintf("%d comentario(s) en el PR", n))
		}
	}
	if hasCritical(fs) {
		return codeRepo
	}
	return codeOK
}

// ─── el workflow ────────────────────────────────────────────────────────────

const workflowPath = ".github/workflows/apus-guard.yml"

// La versión de apus y la de checkout van fijas: el workflow corre siempre lo
// mismo, y el binario se verifica contra el SHA256SUMS de la release.
const workflowTemplate = `# apus-guard: revisa cada PR buscando secretos escritos en el código (SQL Server,
# Azure Storage, Service Bus / Event Hubs y claves de appsettings.json) y los
# comenta en su línea. Si hay algo crítico el check falla: con branch protection
# que lo exija ("apus-guard / guard"), el PR no se puede mergear.
#
# Lo generó apus guard init (apus {{version}}).
name: apus-guard

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: bajar apus {{version}}
        env:
          APUS_VERSION: '{{version}}'
        run: |
          set -eu
          cd "$RUNNER_TEMP"
          base="https://github.com/miguelacaceresrios/Apus/releases/download/v$APUS_VERSION"
          curl -fsSLO "$base/apus-linux-amd64"
          curl -fsSLO "$base/SHA256SUMS.txt"
          grep ' apus-linux-amd64$' SHA256SUMS.txt | sha256sum -c -
          chmod +x apus-linux-amd64

      - name: buscar secretos en el PR
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: '"$RUNNER_TEMP/apus-linux-amd64" guard --pr'
`

func workflowYAML() string { return strings.ReplaceAll(workflowTemplate, "{{version}}", version) }

// writeWorkflow deja el workflow en el repo. Si ya hay uno distinto, no lo pisa.
func writeWorkflow(dir string) (string, error) {
	p := filepath.Join(dir, filepath.FromSlash(workflowPath))
	want := workflowYAML()
	if cur, err := os.ReadFile(p); err == nil {
		if string(cur) == want {
			return p, nil
		}
		return p, errors.New("ya hay un " + workflowPath + " distinto: borralo si querés que apus lo vuelva a generar")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return p, err
	}
	return p, os.WriteFile(p, []byte(want), 0o644)
}

// ─── apus guard ─────────────────────────────────────────────────────────────

func printFindings(fs []Finding) {
	if len(fs) == 0 {
		okMsg("apus-guard: no encontré secretos")
		return
	}
	for _, f := range fs {
		mark, sev := paint("31", "✖"), "CRÍTICO"
		if f.Severity == sevWarning {
			mark, sev = paint("33", "!"), "AVISO"
		}
		fmt.Fprintf(os.Stderr, "%s %s  %s:%d  %s\n", mark, sev, f.File, f.Line, f.Title)
		fmt.Fprintln(os.Stderr, paint("2", "    "+f.Snippet))
		fmt.Fprintln(os.Stderr, paint("2", "    → "+f.Fix))
	}
}

func cmdGuard(args []string) int {
	asJSON := false
	var dir string
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "--pr":
			return guardPR()
		case "init":
			d := "."
			if i+1 < len(args) {
				d = args[i+1]
			}
			p, err := writeWorkflow(d)
			if err != nil {
				return dieMsg(codeRepo, err.Error(), "")
			}
			okMsg("listo: " + filepath.ToSlash(p))
			note("se sube con el próximo push; para que bloquee el merge, pedí el check \"apus-guard / guard\" en la branch protection")
			return codeOK
		case "--json":
			asJSON = true
		case "-h", "--help":
			printUsage()
			return codeOK
		default:
			if strings.HasPrefix(a, "-") || dir != "" {
				return dieMsg(codeUsage, "opción desconocida: "+a, "uso: apus guard [--json] [CARPETA] | apus guard init [CARPETA] | apus guard --pr")
			}
			dir = a
		}
	}
	if dir == "" {
		dir, _ = os.Getwd()
	}
	remote, _ := git(dir, "remote", "get-url", "origin")
	fs, ignored, err := GuardLocal(dir, remote)
	if err != nil {
		return dieMsg(codeRepo, "no pude revisar la carpeta: "+firstLine(err.Error()), "")
	}
	if ignored > 0 && !asJSON {
		note(fmt.Sprintf("%d hallazgo(s) ignorado(s) en Aerodramus", ignored))
	}
	if asJSON {
		if fs == nil {
			fs = []Finding{}
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetEscapeHTML(false)
		enc.Encode(fs)
	} else {
		printFindings(fs)
	}
	if hasCritical(fs) {
		return codeRepo
	}
	return codeOK
}
