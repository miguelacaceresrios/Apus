package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPushTrouble(t *testing.T) {
	casos := []struct{ salida, motivo string }{
		{"fatal: unable to access 'https://github.com/u/r.git/': Could not resolve host: github.com", reasonOffline},
		{"fatal: unable to access 'https://github.com/u/r.git/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server", reasonOffline},
		{"ssh: Could not resolve hostname github.com: No such host is known.\r\nfatal: Could not read from remote repository.", reasonOffline},
		{"ssh: connect to host github.com port 22: Network is unreachable\nfatal: Could not read from remote repository.", reasonOffline},
		{"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", reasonAuth},
		{"fatal: could not read Username for 'https://github.com': terminal prompts disabled", reasonAuth},
		{"remote: Repository not found.\nfatal: repository 'https://github.com/u/r.git/' not found", reasonNotFound},
		{"fatal: '/tmp/nada' does not appear to be a git repository", reasonNotFound},
		{" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", reasonBehind},
		{"remote: error: GH006: Protected branch update failed", reasonPush},
	}
	for _, c := range casos {
		if motivo, _ := pushTrouble(c.salida); motivo != c.motivo {
			t.Errorf("%q: %s, y era %s", c.salida, motivo, c.motivo)
		}
	}
}

func TestBrowseURLSinCredenciales(t *testing.T) {
	casos := map[string]string{
		"https://usuario:ghp_secreto@github.com/u/r.git": "https://github.com/u/r",
		"https://oauth2@gitlab.com/u/r":                  "https://gitlab.com/u/r",
		"git@github.com:u/r.git":                         "https://github.com/u/r",
		"/tmp/remoto.git":                                "",
	}
	for remoto, esperado := range casos {
		if url := browseURL(remoto); url != esperado {
			t.Errorf("%s: %q, y era %q", remoto, url, esperado)
		}
	}
}

// vuelo corre apus en dir, como desde la terminal, y devuelve el código y lo
// que dejó en stdout.
func vuelo(t *testing.T, dir string, args ...string) (int, string) {
	t.Helper()
	t.Chdir(dir)
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = stdout }()
	quiet = true
	defer func() { quiet = false }()

	code := run(args)
	w.Close()
	out, _ := io.ReadAll(r)
	return code, string(out)
}

func leerJSON(t *testing.T, salida string) flightJSON {
	t.Helper()
	lineas := strings.Split(strings.TrimSpace(salida), "\n")
	if len(lineas) != 1 {
		t.Fatalf("stdout tiene que ser una sola línea JSON:\n%s", salida)
	}
	var f flightJSON
	if err := json.Unmarshal([]byte(lineas[0]), &f); err != nil {
		t.Fatalf("%v:\n%s", err, salida)
	}
	return f
}

func TestJSONSubida(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "proyecto", "a.txt")
	remoto := bare(t, tmp, "remoto.git")
	sh(t, dir, "git", "init", "-q")
	sh(t, dir, "git", "remote", "add", "origin", remoto)

	code, salida := vuelo(t, dir, "--json", "-m", "primero")
	f := leerJSON(t, salida)
	if code != codeOK || !f.OK || f.Code != 0 || f.Reason != "" {
		t.Fatalf("tenía que salir bien: %d %+v", code, f)
	}
	if !f.Committed || !f.Pushed || f.Commit == "" || f.Branch != "main" || f.Target != "origin/main" || f.Apus != version {
		t.Errorf("faltan datos: %+v", f)
	}
	if len(f.Steps) != 3 || f.Steps[0].Cmd != "git add -A" {
		t.Errorf("pasos: %+v", f.Steps)
	}

	// Sin cambios: sale bien, sin commit.
	_, salida = vuelo(t, dir, "--json")
	if f := leerJSON(t, salida); !f.OK || f.Committed || f.Pushed || f.Steps == nil {
		t.Errorf("sin cambios: %+v", f)
	}
}

func TestJSONErrores(t *testing.T) {
	tmp := entorno(t)

	// Sin remoto.
	dir := carpeta(t, tmp, "sin-remoto", "a.txt")
	sh(t, dir, "git", "init", "-q")
	code, salida := vuelo(t, dir, "--json")
	if f := leerJSON(t, salida); code != codeRepo || f.OK || f.Reason != reasonNoRemote || f.Hint == "" || !f.Committed {
		t.Errorf("sin remoto: %d %+v", code, f)
	}

	// Sin conexión: el commit queda hecho, el push falla.
	dir = carpeta(t, tmp, "sin-red", "a.txt")
	sh(t, dir, "git", "init", "-q")
	sh(t, dir, "git", "remote", "add", "origin", "https://127.0.0.1:1/u/r.git")
	code, salida = vuelo(t, dir, "--json")
	if f := leerJSON(t, salida); code != codePush || f.Reason != reasonOffline || !f.Committed || f.Pushed || !strings.Contains(f.Hint, "quedó guardado") {
		t.Errorf("sin conexión: %d %+v", code, f)
	}

	// No es un repo: con --json no pregunta si lo inicializa.
	dir = carpeta(t, tmp, "suelta", "a.txt")
	code, salida = vuelo(t, dir, "--json")
	if f := leerJSON(t, salida); code != codeRepo || f.Reason != reasonNotRepo {
		t.Errorf("no es un repo: %d %+v", code, f)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		t.Error("no tenía que inicializar nada")
	}

	// Opciones mal escritas, aunque --json venga después.
	code, salida = vuelo(t, dir, "--nada", "--json")
	if f := leerJSON(t, salida); code != codeUsage || f.Reason != reasonUsage || f.Steps == nil {
		t.Errorf("uso: %d %+v", code, f)
	}
}
