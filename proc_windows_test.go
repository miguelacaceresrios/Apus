//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// El error que no puede volver: un binario de terminal que se cree ventana abre
// cuadros de diálogo modales y se cuelga esperando un clic.
func TestGuiModeSeDecidePorElBinario(t *testing.T) {
	if guiMode() {
		t.Fatal("el binario de pruebas es de consola y guiMode() dijo que es de ventana")
	}

	dir := t.TempDir()
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte("package main\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	build := func(name string, flags ...string) string {
		out := filepath.Join(dir, name)
		args := append([]string{"build", "-o", out}, flags...)
		cmd := exec.Command("go", append(args, src)...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GO111MODULE=off")
		if msg, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("no pude compilar %s: %v\n%s", name, err, msg)
		}
		return out
	}

	if isGUIBinary(build("consola.exe")) {
		t.Error("un binario normal no es de ventana")
	}
	if !isGUIBinary(build("ventana.exe", "-ldflags=-H=windowsgui")) {
		t.Error("un binario con -H=windowsgui es de ventana")
	}
	if isGUIBinary(src) {
		t.Error("un archivo que no es ejecutable no es de ventana")
	}
}

// Sin consola propia, cada git tiene que arrancar oculto; con consola, tiene que
// poder usarla. La prueba verifica la regla en el entorno donde corra.
func TestNoConsoleSigueALaConsolaDelProceso(t *testing.T) {
	h, _, _ := getConsoleWindow.Call()
	cmd := exec.Command("git", "--version")
	noConsole(cmd)

	oculto := cmd.SysProcAttr != nil && cmd.SysProcAttr.CreationFlags&createNoWindow != 0
	if h == 0 && !oculto {
		t.Error("sin consola, git abriría su propia ventana negra")
	}
	if h != 0 && oculto {
		t.Error("con consola, git quedaría sin terminal donde pedir claves")
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git no arrancó con esa configuración: %v\n%s", err, out)
	}
}

// El instalador saca apus.exe y apusw.exe de un solo binario, cambiando el
// subsistema: la copia tiene que quedar del tipo pedido y seguir arrancando.
func TestCopyWithSubsystem(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "main.go")
	if err := os.WriteFile(src, []byte("package main\nimport \"os\"\nfunc main() { os.Exit(7) }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	orig := filepath.Join(dir, "orig.exe")
	cmd := exec.Command("go", "build", "-o", orig, src)
	cmd.Env = append(os.Environ(), "GO111MODULE=off")
	if msg, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("no pude compilar: %v\n%s", err, msg)
	}

	gui := filepath.Join(dir, "gui.exe")
	if err := copyWithSubsystem(orig, gui, subsystemGUI); err != nil {
		t.Fatal(err)
	}
	if !isGUIBinary(gui) {
		t.Fatal("la copia de ventana quedó de consola")
	}
	back := filepath.Join(dir, "back.exe")
	if err := copyWithSubsystem(gui, back, subsystemConsole); err != nil {
		t.Fatal(err)
	}
	if isGUIBinary(back) {
		t.Fatal("la copia de consola quedó de ventana")
	}
	for _, exe := range []string{gui, back} {
		err := exec.Command(exe).Run()
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 7 {
			t.Fatalf("%s no arrancó bien: %v", filepath.Base(exe), err)
		}
	}

	// Pisar un binario existente también anda (y deja el viejo aparte).
	if err := copyWithSubsystem(orig, gui, subsystemGUI); err != nil {
		t.Fatalf("no pude reemplazar un binario existente: %v", err)
	}
	if err := copyWithSubsystem(src, filepath.Join(dir, "x.exe"), subsystemGUI); err == nil {
		t.Fatal("un archivo que no es ejecutable no se tendría que copiar")
	}
}
