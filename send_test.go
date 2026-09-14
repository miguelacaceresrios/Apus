package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// entorno arma un git aislado: identidad propia y nada de la configuración del
// usuario, para que las pruebas den lo mismo en cualquier máquina.
func entorno(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(tmp, "gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	for _, kv := range [][2]string{
		{"user.name", "apus test"}, {"user.email", "test@example.com"}, {"init.defaultBranch", "main"},
	} {
		sh(t, tmp, "git", "config", "--global", kv[0], kv[1])
	}
	return tmp
}

func sh(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func carpeta(t *testing.T, base, nombre string, archivos ...string) string {
	t.Helper()
	dir := filepath.Join(base, nombre)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range archivos {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(f+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func bare(t *testing.T, base, nombre string) string {
	t.Helper()
	dir := filepath.Join(base, nombre)
	sh(t, base, "git", "init", "-q", "--bare", dir)
	return dir
}

// commitsEn cuenta los commits que llegaron a la rama main de un remoto.
func commitsEn(t *testing.T, remoto string) int {
	t.Helper()
	cmd := exec.Command("git", "--git-dir", remoto, "rev-list", "--count", "main")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range strings.TrimSpace(string(out)) {
		n = n*10 + int(c-'0')
	}
	return n
}

func codigo(err error) int {
	if f, ok := err.(*Fail); ok {
		return f.Code
	}
	if err != nil {
		return -1
	}
	return codeOK
}

func TestSendCarpetaNueva(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "proyecto", "a.txt", "b.txt")
	remoto := bare(t, tmp, "remoto.git")

	res, err := Send(dir, remoto)
	if err != nil {
		t.Fatalf("no subió: %v", err)
	}
	if !res.Pushed || !res.Committed {
		t.Fatalf("esperaba commit y push, quedó %+v", res)
	}
	if commitsEn(t, remoto) != 1 {
		t.Fatal("el commit no llegó al remoto")
	}
	if got := sh(t, dir, "git", "remote", "get-url", "origin"); got != remoto {
		t.Fatalf("origin quedó en %q", got)
	}
}

func TestSendRepoAlDiaNoHaceNada(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "proyecto", "a.txt")
	remoto := bare(t, tmp, "remoto.git")
	if _, err := Send(dir, remoto); err != nil {
		t.Fatal(err)
	}

	res, err := Send(dir, remoto)
	if err != nil {
		t.Fatalf("la segunda vez no debería fallar: %v", err)
	}
	if res.Pushed || !strings.Contains(res.Summary, "nada que hacer") {
		t.Fatalf("esperaba 'nada que hacer', quedó %q", res.Summary)
	}
}

func TestSendCambiosNuevosSeSuben(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "proyecto", "a.txt")
	remoto := bare(t, tmp, "remoto.git")
	if _, err := Send(dir, remoto); err != nil {
		t.Fatal(err)
	}
	carpeta(t, tmp, "proyecto", "nuevo.txt")

	if _, err := Send(dir, remoto); err != nil {
		t.Fatal(err)
	}
	if commitsEn(t, remoto) != 2 {
		t.Fatal("el segundo commit no llegó")
	}
}

// El caso delicado: todo subido a un remoto, se cambia la URL por otra, y el
// seguimiento viejo dice "al día". Igual tiene que subirse al remoto nuevo.
func TestSendCambiarURLSubeAlNuevo(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "proyecto", "a.txt")
	viejo := bare(t, tmp, "viejo.git")
	nuevo := bare(t, tmp, "nuevo.git")
	if _, err := Send(dir, viejo); err != nil {
		t.Fatal(err)
	}

	res, err := Send(dir, nuevo)
	if err != nil {
		t.Fatalf("no subió al remoto nuevo: %v", err)
	}
	if commitsEn(t, nuevo) != 1 {
		t.Fatal("el remoto nuevo quedó vacío")
	}
	if !strings.Contains(res.Note, viejo) {
		t.Fatalf("tenía que avisar que origin cambió, la nota dice %q", res.Note)
	}
}

func TestSendCarpetaVacia(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "vacia")
	_, err := Send(dir, bare(t, tmp, "remoto.git"))
	if codigo(err) != codeRepo || !strings.Contains(err.Error(), "vacía") {
		t.Fatalf("esperaba 'carpeta vacía', vino %v", err)
	}
}

func TestSendDentroDeOtroRepo(t *testing.T) {
	tmp := entorno(t)
	padre := carpeta(t, tmp, "padre", "a.txt")
	sh(t, padre, "git", "init", "-q")
	hija := carpeta(t, padre, "hija", "b.txt")

	_, err := Send(hija, bare(t, tmp, "remoto.git"))
	if codigo(err) != codeRepo || !strings.Contains(err.Error(), "dentro de otro repo") {
		t.Fatalf("no tenía que subir el repo padre, vino %v", err)
	}
	if _, err := exec.Command("git", "-C", padre, "remote", "get-url", "origin").Output(); err == nil {
		t.Fatal("le puso remoto al repo padre")
	}
}

// Un repo creado en GitHub con README ya tiene commits: git rechaza el push y
// apus lo explica en criollo.
func TestSendRemotoConArchivos(t *testing.T) {
	tmp := entorno(t)
	remoto := bare(t, tmp, "remoto.git")
	otro := carpeta(t, tmp, "otro", "README.md")
	if _, err := Send(otro, remoto); err != nil {
		t.Fatal(err)
	}

	dir := carpeta(t, tmp, "mio", "a.txt")
	_, err := Send(dir, remoto)
	if codigo(err) != codePush {
		t.Fatalf("esperaba push rechazado, vino %v", err)
	}
	if !strings.Contains(err.(*Fail).Hint, "README") {
		t.Fatalf("la pista no ayuda: %q", err.(*Fail).Hint)
	}
}

func TestSendEntradasInvalidas(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "proyecto", "a.txt")

	if _, err := Send(dir, ""); codigo(err) != codeUsage {
		t.Errorf("URL vacía: %v", err)
	}
	if _, err := Send(dir, "cualquier cosa"); codigo(err) != codeUsage {
		t.Errorf("URL inventada: %v", err)
	}
	if _, err := Send(filepath.Join(tmp, "no-existe"), bare(t, tmp, "r.git")); codigo(err) != codeRepo {
		t.Errorf("carpeta inexistente: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		t.Error("con la URL mal no tenía que inicializar nada")
	}
}

func TestInspect(t *testing.T) {
	tmp := entorno(t)
	nueva := carpeta(t, tmp, "nueva", "a.txt")
	if in := Inspect(nueva); !in.Exists || in.IsRepo || in.InsideOf != "" {
		t.Errorf("carpeta nueva: %+v", in)
	}

	remoto := bare(t, tmp, "remoto.git")
	if _, err := Send(nueva, remoto); err != nil {
		t.Fatal(err)
	}
	if in := Inspect(nueva); !in.IsRepo || in.RemoteURL != remoto || in.Summary != "al día" {
		t.Errorf("repo subido: %+v", in)
	}

	hija := carpeta(t, nueva, "sub", "b.txt")
	if in := Inspect(hija); in.IsRepo || in.InsideOf == "" {
		t.Errorf("subcarpeta de un repo: %+v", in)
	}
	if in := Inspect("relativa/no"); in.Exists {
		t.Errorf("una ruta relativa no debería contar: %+v", in)
	}
}
