//go:build windows

package main

import (
	"os"
	"syscall"
)

// isTerminal usa la consola de Windows: si el handle tiene modo de consola,
// es una terminal de verdad y no un archivo o NUL.
func isTerminal(f *os.File) bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(f.Fd()), &mode) == nil
}
