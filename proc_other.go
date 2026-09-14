//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
)

// Fuera de Windows no hay binario de ventana: los procesos no abren consolas
// propias y los errores siempre tienen una terminal o un log donde ir.

func guiMode() bool { return false }

func noConsole(*exec.Cmd) {}

func alert(title, text string) { fmt.Fprintf(os.Stderr, "%s: %s\n", title, text) }
