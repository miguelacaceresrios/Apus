package main

import "os"

// canPrompt dice si tiene sentido hacer preguntas: hay una terminal, o alguien
// nos está mandando respuestas por un pipe (scripts y tests). Con la entrada
// vacía (cron, hooks, CI) no preguntamos nada.
func canPrompt() bool {
	if isTerminal(os.Stdin) {
		return true
	}
	st, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return st.Mode()&os.ModeNamedPipe != 0
}
