package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const fakeToken = "ghp_fakeTokenForTests0123456789abcdef"

func TestGithubRepo(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/miguel/apus.git":       "miguel/apus",
		"https://github.com/miguel/apus":           "miguel/apus",
		"https://user:tok@github.com/miguel/apus/": "miguel/apus",
		"git@github.com:miguel/apus.git":           "miguel/apus",
		"ssh://git@github.com/miguel/apus.git":     "miguel/apus",
		"https://gitlab.com/miguel/apus.git":       "",
		"https://github.com/miguel":                "",
		`C:\repos\remoto.git`:                      "",
		"https://github.com.evil.example/miguel/x": "",
	} {
		o, r, ok := githubRepo(in)
		got := ""
		if ok {
			got = o + "/" + r
		}
		if got != want {
			t.Errorf("githubRepo(%q) = %q, esperaba %q", in, got, want)
		}
	}
}

// fakeGitHub simula la API: issues y revisiones de PR, y anota lo que recibe.
type fakeGitHub struct {
	mu        sync.Mutex
	issues    []map[string]any
	created   []map[string]any
	comments  []map[string]any
	reviews   []map[string]any
	rejectLab bool
	auths     []string
}

func (f *fakeGitHub) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		body, _ := io.ReadAll(r.Body)
		var req map[string]any
		json.Unmarshal(body, &req)
		switch {
		case r.Method == "GET" && r.URL.Path == "/repos/o/r/issues":
			json.NewEncoder(w).Encode(f.issues)
		case r.Method == "POST" && r.URL.Path == "/repos/o/r/issues":
			if _, ok := req["labels"]; ok && f.rejectLab {
				w.WriteHeader(422)
				w.Write([]byte(`{"message":"Validation Failed"}`))
				return
			}
			f.created = append(f.created, req)
			n := len(f.issues) + 1
			issue := map[string]any{"number": n, "html_url": "https://github.com/o/r/issues/" + string(rune('0'+n)), "body": req["body"]}
			f.issues = append(f.issues, issue)
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(issue)
		case r.Method == "GET" && r.URL.Path == "/repos/o/r/pulls/5/comments":
			json.NewEncoder(w).Encode(f.comments)
		case r.Method == "POST" && r.URL.Path == "/repos/o/r/pulls/5/reviews":
			f.reviews = append(f.reviews, req)
			w.WriteHeader(200)
			w.Write([]byte(`{}`))
		case r.URL.Path == "/user":
			if r.Header.Get("Authorization") != "Bearer "+fakeToken {
				w.WriteHeader(401)
				w.Write([]byte(`{"message":"Bad credentials"}`))
				return
			}
			w.Write([]byte(`{"login":"miguel"}`))
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"message":"Not Found"}`))
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("APUS_GITHUB_API", srv.URL)
	return srv
}

func hallazgos() []Finding {
	fs := scanFile("appsettings.json", []byte(`{
  "ConnectionStrings": { "Db": "Server=db;Database=x;User ID=sa;Password=Muy-Secreta1" },
  "AzureAd": { "ClientId": "8f2c1d9e-1111-2222-3333-444455556666" }
}`))
	if len(fs) != 2 {
		panic("esperaba dos hallazgos de prueba")
	}
	return fs
}

func TestReportIssuesSinDuplicar(t *testing.T) {
	gh := &fakeGitHub{rejectLab: true}
	gh.server(t)
	c := newGitHub(fakeToken)
	fs := hallazgos()

	refs, err := reportIssues(c, "o", "r", fs)
	if err != nil {
		t.Fatal(err)
	}
	// Solo el crítico abre issue; el aviso no.
	if len(refs) != 1 || !refs[0].New || len(gh.created) != 1 {
		t.Fatalf("esperaba un issue nuevo: %+v", refs)
	}
	is := gh.created[0]
	body := is["body"].(string)
	for _, want := range []string{"appsettings.json", "| Línea | 2 |", "Crítico", "dotnet user-secrets", "<!-- apus-guard:" + fs[0].ID + " -->", "Mu****"} {
		if !strings.Contains(body, want) && !strings.Contains(is["title"].(string), want) {
			t.Errorf("al issue le falta %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "Muy-Secreta1") || strings.Contains(is["title"].(string), "Muy-Secreta1") {
		t.Fatal("el secreto llegó al issue")
	}

	// La segunda vez ya hay uno abierto con la misma marca: no se repite.
	refs, err = reportIssues(c, "o", "r", fs)
	if err != nil || len(refs) != 1 || refs[0].New || len(gh.created) != 1 {
		t.Fatalf("no tenía que duplicar el issue: %v %+v", err, refs)
	}
	for _, a := range gh.auths {
		if a != "Bearer "+fakeToken {
			t.Fatalf("pedido sin el token: %q", a)
		}
	}
}

func TestErroresNoMuestranElToken(t *testing.T) {
	c := newGitHub(fakeToken)
	c.api = "http://127.0.0.1:1/" + fakeToken // una URL que falla y que trae el token adentro
	err := c.do("GET", "/user", nil, nil)
	if err == nil || strings.Contains(err.Error(), fakeToken) {
		t.Fatalf("el error deja ver el token: %v", err)
	}

	gh := &fakeGitHub{}
	gh.server(t)
	if _, err := newGitHub("otro-token").whoami(); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("un token malo tiene que dar 401: %v", err)
	}
	if login, err := newGitHub(fakeToken).whoami(); err != nil || login != "miguel" {
		t.Fatalf("whoami: %v %q", err, login)
	}
}

func TestPostReviewComentaEnLaLinea(t *testing.T) {
	gh := &fakeGitHub{}
	gh.server(t)
	c := newGitHub(fakeToken)
	fs := hallazgos()
	// Uno de los dos ya se comentó en una corrida anterior.
	gh.comments = []map[string]any{{"body": "viejo " + marker(fs[1])}}

	n, err := postReview(c, "o", "r", 5, "abc123", fs)
	if err != nil || n != 1 || len(gh.reviews) != 1 {
		t.Fatalf("esperaba una revisión con un comentario: %v %d", err, n)
	}
	rev := gh.reviews[0]
	if rev["commit_id"] != "abc123" || rev["event"] != "COMMENT" {
		t.Fatalf("revisión mal armada: %+v", rev)
	}
	cs := rev["comments"].([]any)
	cm := cs[0].(map[string]any)
	if cm["path"] != "appsettings.json" || cm["line"].(float64) != 2 || cm["side"] != "RIGHT" {
		t.Fatalf("el comentario no va a la línea: %+v", cm)
	}
	if strings.Contains(cm["body"].(string), "Muy-Secreta1") {
		t.Fatal("el secreto llegó al comentario")
	}

	// Todo comentado: no hay revisión nueva.
	gh.comments = append(gh.comments, map[string]any{"body": marker(fs[0])})
	if n, err := postReview(c, "o", "r", 5, "abc123", fs); err != nil || n != 0 || len(gh.reviews) != 1 {
		t.Fatalf("no tenía que repetir comentarios: %v %d", err, n)
	}
}

func TestWriteWorkflow(t *testing.T) {
	dir := t.TempDir()
	p, err := writeWorkflow(dir)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	y := string(data)
	for _, want := range []string{"pull_request", "pull-requests: write", "fetch-depth: 0", "sha256sum -c", "guard --pr", "APUS_VERSION: '" + version + "'", "${{ github.token }}"} {
		if !strings.Contains(y, want) {
			t.Errorf("al workflow le falta %q", want)
		}
	}
	if filepath.ToSlash(p) != filepath.ToSlash(filepath.Join(dir, workflowPath)) {
		t.Errorf("quedó en %s", p)
	}
	// Idéntico: no pasa nada. Distinto: no lo pisa.
	if _, err := writeWorkflow(dir); err != nil {
		t.Fatalf("regenerarlo igual no es un error: %v", err)
	}
	os.WriteFile(p, []byte("mío"), 0o644)
	if _, err := writeWorkflow(dir); err == nil {
		t.Fatal("pisó un workflow editado")
	}
}

// El modo Actions de punta a punta: un PR con un secreto en una línea nueva
// falla y comenta; lo que ya estaba antes del PR no cuenta.
func TestGuardPR(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "repo")
	os.WriteFile(filepath.Join(dir, "appsettings.json"), []byte("{\n  \"Viejo\": { \"ApiKey\": \"ya-estaba-antes-1234\" },\n  \"Fin\": 1\n}\n"), 0o644)
	sh(t, dir, "git", "init", "-q")
	sh(t, dir, "git", "add", "-A")
	sh(t, dir, "git", "commit", "-qm", "base")
	base := sh(t, dir, "git", "rev-parse", "HEAD")
	os.WriteFile(filepath.Join(dir, "appsettings.json"), []byte("{\n  \"Viejo\": { \"ApiKey\": \"ya-estaba-antes-1234\" },\n  \"Nuevo\": { \"ClientSecret\": \"recien-agregado-5678\" },\n  \"Fin\": 1\n}\n"), 0o644)
	sh(t, dir, "git", "commit", "-qam", "pr")
	head := sh(t, dir, "git", "rev-parse", "HEAD")

	fs, err := GuardDiff(dir, base, head)
	if err != nil || len(fs) != 1 || fs[0].Key != "Nuevo:ClientSecret" || fs[0].Line != 3 {
		t.Fatalf("esperaba solo el secreto nuevo, en la línea 3: %v %+v", err, fs)
	}

	gh := &fakeGitHub{}
	gh.server(t)
	event := filepath.Join(tmp, "event.json")
	os.WriteFile(event, []byte(`{"pull_request":{"number":5,"base":{"sha":"`+base+`"},"head":{"sha":"`+head+`"}}}`), 0o644)
	t.Setenv("GITHUB_EVENT_PATH", event)
	t.Setenv("GITHUB_REPOSITORY", "o/r")
	t.Setenv("GITHUB_TOKEN", fakeToken)
	wd, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(wd)

	if code := guardPR(); code != codeRepo {
		t.Fatalf("con un secreto crítico el check tiene que fallar, salió %d", code)
	}
	if len(gh.reviews) != 1 {
		t.Fatal("no comentó el PR")
	}
}
