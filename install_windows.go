//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Instalar en Windows es: apus.exe, apusw.exe y aerodramus.exe (los tres, el
// mismo binario) en %LOCALAPPDATA%\Programs\apus, esa carpeta en el PATH del
// usuario, accesos en el menú Inicio (y el de apus en el escritorio), y una
// entrada en "Aplicaciones instaladas" para desinstalar. Todo por usuario:
// no pide permisos de administrador.

func installDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "apus")
}

// Los subsistemas del encabezado PE: lo único que distingue a apus.exe de apusw.exe.
const (
	subsystemGUI     = 2
	subsystemConsole = 3
)

// copyWithSubsystem copia el ejecutable src a dst con otro subsistema. Así un
// solo binario descargado alcanza para instalar los dos: el de la terminal y el
// de la ventana son el mismo código compilado, salvo por ese campo.
func copyWithSubsystem(src, dst string, subsystem uint16) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if len(data) < 0x40 || string(data[:2]) != "MZ" {
		return errors.New("no es un ejecutable de Windows: " + src)
	}
	peOff := int(binary.LittleEndian.Uint32(data[0x3c:]))
	// "PE\0\0", 20 bytes de cabecera COFF, y el campo Subsystem está en el byte
	// 68 de la cabecera opcional, igual en PE32 y PE32+.
	field := peOff + 4 + 20 + 68
	if field+2 > len(data) || string(data[peOff:peOff+4]) != "PE\x00\x00" {
		return errors.New("encabezado PE inesperado en " + src)
	}
	binary.LittleEndian.PutUint16(data[field:], subsystem)

	// Windows no deja pisar un .exe que está corriendo, pero sí renombrarlo: el
	// viejo se aparta y se borra; si sigue corriendo, en la próxima instalación.
	old := dst + ".old"
	os.Remove(old)
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			return fmt.Errorf("no pude reemplazar %s: %v", dst, err)
		}
	}
	if err := os.WriteFile(dst, data, 0o755); err != nil {
		return err
	}
	os.Remove(old)
	return nil
}

// El resto de la instalación es PowerShell: accesos directos (COM), el PATH del
// usuario y la entrada del desinstalador, sin agregar dependencias a apus.
const installScript = `
$ErrorActionPreference = 'Stop'
$dir = $env:APUS_DIR
$gui = Join-Path $dir 'apusw.exe'

$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($path -split ';' | Where-Object { $_ -ne '' })
if ($parts -notcontains $dir) {
	[Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
}

$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$ws = New-Object -ComObject WScript.Shell
foreach ($folder in @($programs, $desktop)) {
	$lnk = $ws.CreateShortcut((Join-Path $folder 'apus.lnk'))
	$lnk.TargetPath = $gui
	$lnk.Arguments = 'ui'
	$lnk.WorkingDirectory = $desktop
	$lnk.IconLocation = "$gui,0"
	$lnk.Description = 'Tu carpeta a GitHub, en un paso'
	$lnk.Save()
}

# Aerodramus solo va al menú Inicio: en el escritorio alcanza con apus.
$lnk = $ws.CreateShortcut((Join-Path $programs 'Aerodramus.lnk'))
$lnk.TargetPath = Join-Path $dir 'aerodramus.exe'
$lnk.WorkingDirectory = $desktop
$lnk.IconLocation = (Join-Path $dir 'aerodramus.ico') + ',0'
$lnk.Description = 'Los hallazgos de apus-guard, para revisarlos'
$lnk.Save()

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\apus'
New-Item -Path $key -Force | Out-Null
$size = [int]((Get-ChildItem $dir -Filter *.exe | Measure-Object Length -Sum).Sum / 1KB)
$values = @{
	DisplayName = 'apus'; DisplayVersion = $env:APUS_VERSION; Publisher = 'apus'
	DisplayIcon = "$gui,0"; InstallLocation = $dir
	UninstallString = '"' + $gui + '" uninstall'
	QuietUninstallString = '"' + $gui + '" uninstall --yes'
}
foreach ($k in $values.Keys) { Set-ItemProperty -Path $key -Name $k -Value $values[$k] }
foreach ($k in 'NoModify', 'NoRepair', 'EstimatedSize') {
	$v = if ($k -eq 'EstimatedSize') { $size } else { 1 }
	New-ItemProperty -Path $key -Name $k -Value $v -PropertyType DWord -Force | Out-Null
}
`

const uninstallScript = `
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:APUS_DIR
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($path -split ';' | Where-Object { $_ -ne '' -and $_ -ne $dir })
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
	Remove-Item (Join-Path $folder 'apus.lnk') -Force
}
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Aerodramus.lnk') -Force
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\apus' -Recurse -Force
# El .exe que corre esto no se puede borrar hasta que termine: se borra la
# carpeta unos segundos después, desde otro proceso.
Start-Process -WindowStyle Hidden cmd.exe -ArgumentList '/c', "timeout /t 3 /nobreak >nul & rmdir /s /q ""$dir"""
`

func powershell(script string, env ...string) error {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), env...)
	noConsole(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, firstLine(strings.TrimSpace(string(out))))
	}
	return nil
}

func selfPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// install deja apus instalado y devuelve la ruta de la ventana.
func install() (string, error) {
	self, err := selfPath()
	if err != nil {
		return "", err
	}
	dir := installDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	gui := filepath.Join(dir, "apusw.exe")
	cli := filepath.Join(dir, "apus.exe")
	aero := filepath.Join(dir, "aerodramus.exe")
	for _, b := range []struct {
		path string
		sub  uint16
	}{{cli, subsystemConsole}, {gui, subsystemGUI}, {aero, subsystemGUI}} {
		if samePath(self, b.path) {
			continue // ya es este mismo
		}
		if err := copyWithSubsystem(self, b.path, b.sub); err != nil {
			return "", err
		}
	}
	// El ícono de Aerodramus, para su acceso: el .exe lleva el de apus.
	if err := os.WriteFile(filepath.Join(dir, "aerodramus.ico"), aeroIcon, 0o644); err != nil {
		return "", err
	}
	if err := powershell(installScript, "APUS_DIR="+dir, "APUS_VERSION="+version); err != nil {
		return "", fmt.Errorf("los binarios quedaron en %s, pero falló el resto: %v", dir, err)
	}
	return gui, nil
}

func cmdInstall(args []string) int {
	for _, a := range args {
		if a != "-q" && a != "--quiet" {
			return dieMsg(codeUsage, "opción desconocida: "+a, "uso: apus install")
		}
		quiet = true
	}
	step("instalando en " + installDir())
	gui, err := install()
	if err != nil {
		return dieMsg(codeRepo, "no pude instalar apus: "+err.Error(), "")
	}
	okMsg("apus " + version + " instalado")
	note("abrilo desde el menú Inicio o el escritorio, o con 'apus' en una terminal nueva; Aerodramus está en el menú Inicio")
	if guiMode() {
		notify("apus", "apus quedó instalado.\n\nLo abrís desde el menú Inicio o el escritorio, y 'apus' funciona en cualquier terminal nueva. Aerodramus, para revisar los hallazgos de apus-guard, está en el menú Inicio.")
		openInstalled(gui)
	}
	return codeOK
}

func cmdUninstall(args []string) int {
	yes := false
	for _, a := range args {
		switch a {
		case "-y", "--yes":
			yes = true
		default:
			return dieMsg(codeUsage, "opción desconocida: "+a, "uso: apus uninstall [--yes]")
		}
	}
	dir := installDir()
	if _, err := os.Stat(dir); err != nil {
		return dieMsg(codeRepo, "apus no está instalado en "+dir, "")
	}
	if !yes && guiMode() && !askYesNo("apus", "¿Desinstalar apus?\n\nSe borran el programa y sus accesos. Tus repos no se tocan.") {
		return codeOK
	}
	if err := powershell(uninstallScript, "APUS_DIR="+dir); err != nil {
		return dieMsg(codeRepo, "no pude desinstalar apus: "+err.Error(), "")
	}
	okMsg("apus desinstalado")
	if guiMode() && !yes {
		notify("apus", "apus quedó desinstalado.")
	}
	return codeOK
}

// offerInstall corre cuando se abre la ventana con doble clic. Si apus no está
// instalado, o lo instalado es otra versión, ofrece instalar esta copia; si
// dice que sí, instala y abre la instalada. Devuelve true si ya se ocupó.
func offerInstall() bool {
	self, err := selfPath()
	if err != nil || samePath(filepath.Dir(self), installDir()) {
		return false
	}
	installed := filepath.Join(installDir(), "apus.exe")
	question := "¿Instalar apus en esta computadora?\n\nQueda en el menú Inicio y en el escritorio, y 'apus' funciona en la terminal. Si decís que no, se abre igual, sin instalar."
	if _, err := os.Stat(installed); err == nil {
		cmd := exec.Command(installed, "version")
		noConsole(cmd)
		out, _ := cmd.Output()
		have := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "apus"))
		if have == version {
			return false
		}
		if have == "" {
			have = "otra versión"
		}
		question = fmt.Sprintf("Tenés instalado apus %s. ¿Actualizarlo a %s?", have, version)
	}
	if !askYesNo("apus", question) {
		return false
	}
	gui, err := install()
	if err != nil {
		alert("apus", "No pude instalar apus:\n\n"+err.Error())
		return false
	}
	return openInstalled(gui)
}

// openInstalled abre la ventana instalada, como la abriría el acceso directo.
func openInstalled(gui string) bool {
	cmd := exec.Command(gui, "ui")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	return cmd.Start() == nil
}
