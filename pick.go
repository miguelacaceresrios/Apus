package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Selector de carpetas del Windows de siempre. La ventana dueña con TopMost es
// para que el diálogo aparezca adelante y no escondido detrás de la de apus.
const pickScriptWindows = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Elegí la carpeta que querés subir'
$d.ShowNewFolderButton = $false
if ($env:APUS_START -and (Test-Path -LiteralPath $env:APUS_START)) { $d.SelectedPath = $env:APUS_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
$owner.Dispose()
`

// pickFolder abre el selector de carpetas del sistema, arrancando en start.
// Devuelve "" sin error si el usuario canceló.
func pickFolder(start string) (string, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("powershell.exe", "-NoProfile", "-STA", "-NonInteractive", "-Command", pickScriptWindows)
		cmd.Env = append(os.Environ(), "APUS_START="+start)
	case "darwin":
		cmd = exec.Command("osascript", "-e", `POSIX path of (choose folder with prompt "Elegí la carpeta que querés subir")`)
	default:
		if p, err := exec.LookPath("zenity"); err == nil {
			cmd = exec.Command(p, "--file-selection", "--directory",
				"--title=Elegí la carpeta que querés subir", "--filename="+start+"/")
		} else if p, err := exec.LookPath("kdialog"); err == nil {
			cmd = exec.Command(p, "--getexistingdirectory", start, "--title", "Elegí la carpeta que querés subir")
		} else {
			return "", errors.New("no encontré un selector de carpetas (zenity o kdialog): escribí la ruta a mano")
		}
	}

	noConsole(cmd)
	out, err := cmd.Output()
	dir := strings.TrimSpace(string(out))
	if err != nil {
		// Cancelar el diálogo sale con código 1 y sin nada escrito: no es un error.
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 && dir == "" {
			return "", nil
		}
		return "", errors.New("no pude abrir el selector de carpetas: " + firstLine(err.Error()))
	}
	return dir, nil
}
