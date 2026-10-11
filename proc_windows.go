//go:build windows

package main

import (
	"debug/pe"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	user32           = syscall.NewLazyDLL("user32.dll")
	getConsoleWindow = kernel32.NewProc("GetConsoleWindow")
	messageBoxW      = user32.NewProc("MessageBoxW")

	guiOnce sync.Once
	guiFlag bool
)

const (
	createNoWindow  = 0x08000000 // CREATE_NO_WINDOW
	mbYesNo         = 0x00000004 // MB_YESNO
	mbIconError     = 0x00000010 // MB_ICONERROR
	mbIconQuestion  = 0x00000020 // MB_ICONQUESTION
	mbIconInfo      = 0x00000040 // MB_ICONINFORMATION
	mbSetForeground = 0x00010000 // MB_SETFOREGROUND
	idYes           = 6
)

// guiMode dice si este es el binario de ventana (apusw.exe). Se decide por cómo
// fue compilado y no por si hay consola: un apus.exe corriendo en CI o desde el
// Programador de tareas tampoco tiene consola, y no por eso debe abrir diálogos.
func guiMode() bool {
	guiOnce.Do(func() {
		if exe, err := os.Executable(); err == nil {
			guiFlag = isGUIBinary(exe)
		}
	})
	return guiFlag
}

// isGUIBinary lee el subsistema de un ejecutable: -H=windowsgui lo marca como
// WINDOWS_GUI, y Windows entonces no le da consola al arrancar.
func isGUIBinary(path string) bool {
	f, err := pe.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	switch oh := f.OptionalHeader.(type) {
	case *pe.OptionalHeader64:
		return oh.Subsystem == pe.IMAGE_SUBSYSTEM_WINDOWS_GUI
	case *pe.OptionalHeader32:
		return oh.Subsystem == pe.IMAGE_SUBSYSTEM_WINDOWS_GUI
	}
	return false
}

// noConsole evita que un proceso hijo abra su propia ventana de consola. Sólo
// hace falta cuando este proceso no tiene consola: si la tiene, git la comparte
// y puede usarla (por ejemplo, para pedir la clave de una llave SSH).
func noConsole(cmd *exec.Cmd) {
	if h, _, _ := getConsoleWindow.Call(); h == 0 {
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	}
}

func messageBox(title, text string, flags uintptr) uintptr {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := messageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags|mbSetForeground)
	return r
}

// alert muestra un error en una ventana del sistema: el binario de ventana no
// tiene terminal donde imprimirlo.
func alert(title, text string) { messageBox(title, text, mbIconError) }

// notify avisa algo que salió bien.
func notify(title, text string) { messageBox(title, text, mbIconInfo) }

// askYesNo hace una pregunta con Sí y No.
func askYesNo(title, text string) bool {
	return messageBox(title, text, mbYesNo|mbIconQuestion) == idYes
}
