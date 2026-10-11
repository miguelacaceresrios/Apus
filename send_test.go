package main

import (
	"encoding/json"
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
	// El log de apus-guard va a la carpeta de la prueba, no al de la máquina.
	t.Setenv("APUS_LOG", filepath.Join(tmp, "guard-log.json"))
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

// Un repo creado en GitHub con README y licencia: el push se rechaza, apus
// trae lo del remoto, ve que no choca y ofrece "Traer y continuar".
func TestSendRemotoConArchivos(t *testing.T) {
	tmp := entorno(t)
	remoto := bare(t, tmp, "remoto.git")
	otro := carpeta(t, tmp, "otro", "README.md", "LICENSE")
	if _, err := Send(otro, remoto); err != nil {
		t.Fatal(err)
	}

	dir := carpeta(t, tmp, "mio", "a.txt")
	res, err := Send(dir, remoto)
	f, ok := err.(*Fail)
	if !ok || f.Reason != reasonDiverged || res.Divergence == nil {
		t.Fatalf("esperaba el análisis de divergencia, vino %v %+v", err, res)
	}
	d := res.Divergence
	if !d.Unrelated || !d.Trivial() || len(d.Incoming) != 2 || d.Lease == "" {
		t.Fatalf("esperaba historias sin relación, sin conflictos, con README y LICENSE entrantes: %+v", d)
	}
	if !res.Committed {
		t.Fatal("el commit local tenía que quedar hecho")
	}

	res, err = Resolve(dir, "pull", "")
	if err != nil || !res.Pushed {
		t.Fatalf("Traer y continuar tenía que subir: %v %+v", err, res)
	}
	if sh(t, dir, "git", "rev-parse", "HEAD") != sh(t, tmp, "git", "--git-dir", remoto, "rev-parse", "main") {
		t.Fatal("el remoto no quedó igual que la carpeta")
	}
	for _, name := range []string{"README.md", "LICENSE", "a.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("falta %s", name)
		}
	}
}

// preparar deja una carpeta cuyo README choca con el del remoto.
func preparar(t *testing.T) (tmp, dir, remoto string) {
	t.Helper()
	return prepararCon(t, "README.md")
}

// prepararCon deja una carpeta cuyo archivo nombre choca con el del remoto.
func prepararCon(t *testing.T, nombre string) (tmp, dir, remoto string) {
	t.Helper()
	tmp = entorno(t)
	remoto = bare(t, tmp, "remoto.git")
	otro := carpeta(t, tmp, "otro", "LICENSE")
	os.WriteFile(filepath.Join(otro, nombre), []byte("# el de GitHub\n"), 0o644)
	if _, err := Send(otro, remoto); err != nil {
		t.Fatal(err)
	}
	dir = carpeta(t, tmp, "mio", "a.txt")
	os.WriteFile(filepath.Join(dir, nombre), []byte("# el mío\n"), 0o644)
	res, err := Send(dir, remoto)
	if f, ok := err.(*Fail); !ok || f.Reason != reasonDiverged {
		t.Fatalf("esperaba divergencia, vino %v", err)
	}
	if d := res.Divergence; d.Trivial() || len(d.Conflicts) != 1 || d.Conflicts[0] != nombre {
		t.Fatalf("esperaba el conflicto en %s: %+v", nombre, d)
	}
	return tmp, dir, remoto
}

// Con conflictos: "Traer y continuar" no se puede; el rebase queda a mitad,
// y Continuar solo sigue cuando ya no hay marcas.
func TestResolveConflictoConRebase(t *testing.T) {
	tmp, dir, remoto := preparar(t)

	if _, err := Resolve(dir, "pull", ""); err == nil || err.(*Fail).Reason != reasonDiverged {
		t.Fatalf("con conflictos, traer y continuar no tenía que hacer nada: %v", err)
	}
	res, err := Resolve(dir, "rebase", "")
	if f, ok := err.(*Fail); !ok || f.Reason != reasonConflicts || res.Divergence == nil || !res.Divergence.Rebasing {
		t.Fatalf("esperaba el rebase a mitad: %v %+v", err, res)
	}
	if in := Inspect(dir); in.Pending == nil || len(in.Pending.Markers) != 1 {
		t.Fatalf("Inspect tenía que ver el conflicto pendiente: %+v", in.Pending)
	}
	if _, err := Send(dir, remoto); err == nil || err.(*Fail).Reason != reasonConflicts {
		t.Fatalf("Subir a mitad de un rebase no tiene que commitear nada: %v", err)
	}

	if _, err := Resolve(dir, "continue", ""); err == nil || !strings.Contains(err.Error(), "marcas de conflicto") {
		t.Fatalf("con marcas en el archivo no tenía que seguir: %v", err)
	}
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# los dos\n"), 0o644)
	res, err = Resolve(dir, "continue", "")
	if err != nil || !res.Pushed {
		t.Fatalf("resuelto, tenía que subir: %v %+v", err, res)
	}
	if got := sh(t, tmp, "git", "--git-dir", remoto, "show", "main:README.md"); got != "# los dos" {
		t.Fatalf("el README subido quedó %q", got)
	}
}

// Con tildes en el nombre, git lo escribe "canci\303\263n.md" si no se le pide
// lo contrario: Continuar no encontraba el archivo, no veía las marcas y las
// subía a GitHub.
func TestResolveConflictoConNombreNoASCII(t *testing.T) {
	tmp, dir, remoto := prepararCon(t, "canción.md")
	res, err := Resolve(dir, "rebase", "")
	if f, ok := err.(*Fail); !ok || f.Reason != reasonConflicts || len(res.Divergence.Markers) != 1 || res.Divergence.Markers[0] != "canción.md" {
		t.Fatalf("esperaba canción.md con marcas: %v %+v", err, res.Divergence)
	}
	if _, err := Resolve(dir, "continue", ""); err == nil || !strings.Contains(err.Error(), "marcas de conflicto") {
		t.Fatalf("con marcas en el archivo no tenía que seguir: %v", err)
	}
	if got := sh(t, tmp, "git", "--git-dir", remoto, "show", "main:canción.md"); got != "# el de GitHub" {
		t.Fatalf("a GitHub llegó %q", got)
	}
}

func TestResolveCancelar(t *testing.T) {
	_, dir, _ := preparar(t)
	antes := sh(t, dir, "git", "rev-parse", "HEAD")
	if _, err := Resolve(dir, "rebase", ""); err == nil {
		t.Fatal("esperaba conflicto")
	}
	res, err := Resolve(dir, "abort", "")
	if f, ok := err.(*Fail); !ok || f.Reason != reasonDiverged || res.Divergence == nil {
		t.Fatalf("después de cancelar tenía que volver a ofrecer las opciones: %v", err)
	}
	if pending(dir) != "" || sh(t, dir, "git", "rev-parse", "HEAD") != antes {
		t.Fatal("cancelar tenía que dejar la carpeta como estaba")
	}
}

// Sobrescribir es explícito y atado al commit que se mostró: si GitHub cambió
// en el medio, no pisa nada.
func TestResolveSobrescribir(t *testing.T) {
	tmp, dir, remoto := preparar(t)
	res, _ := Send(dir, remoto)
	lease := res.Divergence.Lease

	if _, err := Resolve(dir, "force", ""); codigo(err) != codeUsage {
		t.Fatalf("sin el commit a pisar no se sobrescribe: %v", err)
	}

	// Alguien sube algo mientras tanto.
	otro := filepath.Join(tmp, "otro")
	os.WriteFile(filepath.Join(otro, "nuevo.txt"), []byte("x\n"), 0o644)
	if _, err := Send(otro, remoto); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(dir, "force", lease); err == nil || !strings.Contains(err.Error(), "cambió mientras decidías") {
		t.Fatalf("con GitHub cambiado no tenía que pisar: %v", err)
	}

	res, _ = Send(dir, remoto)
	res, err := Resolve(dir, "force", res.Divergence.Lease)
	if err != nil || !res.Pushed {
		t.Fatalf("con el commit al día tenía que sobrescribir: %v", err)
	}
	if sh(t, dir, "git", "rev-parse", "HEAD") != sh(t, tmp, "git", "--git-dir", remoto, "rev-parse", "main") {
		t.Fatal("el remoto no quedó como la carpeta")
	}
}

// Con un secreto crítico, Subir no toca nada: ni init, ni remoto, ni commit.
func TestSendFrenaSecretos(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "api", "a.txt")
	os.WriteFile(filepath.Join(dir, "appsettings.json"), []byte(`{"ConnectionStrings":{"Db":"Server=db;Database=x;User ID=sa;Password=Muy-Secreta1"}}`), 0o644)
	remoto := bare(t, tmp, "remoto.git")

	var reported []Finding
	orig := reportSecrets
	reportSecrets = func(url string, fs []Finding) ([]IssueRef, string) {
		reported = fs
		return []IssueRef{{Finding: fs[0].ID, Number: 7, URL: "https://github.com/x/y/issues/7", New: true}}, ""
	}
	defer func() { reportSecrets = orig }()

	res, err := Send(dir, remoto)
	if f, ok := err.(*Fail); !ok || f.Reason != reasonSecrets {
		t.Fatalf("esperaba el freno de apus-guard: %v", err)
	}
	if len(res.Findings) != 1 || len(res.Issues) != 1 || len(reported) != 1 {
		t.Fatalf("esperaba el hallazgo y su issue: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		t.Fatal("con un secreto no tenía que inicializar nada")
	}
	if commitsEn(t, remoto) != 0 {
		t.Fatal("llegó algo al remoto")
	}
	data, _ := json.Marshal(res)
	if strings.Contains(string(data), "Muy-Secreta1") {
		t.Fatal("el secreto aparece en la respuesta")
	}

	// Un aviso no frena.
	os.WriteFile(filepath.Join(dir, "appsettings.json"), []byte(`{"AzureAd":{"ClientId":"8f2c1d9e-1111-2222-3333-444455556666"}}`), 0o644)
	res, err = Send(dir, remoto)
	if err != nil || !res.Pushed || len(res.Findings) != 1 || res.Findings[0].Severity != sevWarning {
		t.Fatalf("con un aviso tenía que subir y avisar: %v %+v", err, res)
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
