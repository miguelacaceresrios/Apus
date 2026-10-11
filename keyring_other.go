//go:build !windows

package main

import (
	"bytes"
	"errors"
	"os/exec"
	"runtime"
	"strings"
)

// En macOS el token va al Llavero (security) y en Linux al llavero de la sesión
// (secret-tool, de libsecret). El secreto viaja siempre por stdin: por
// argumentos lo vería cualquiera que liste los procesos.

func keyringSet(name, secret string) error {
	switch runtime.GOOS {
	case "darwin":
		// security -i lee los comandos de stdin.
		cmd := exec.Command("security", "-i")
		cmd.Stdin = strings.NewReader("add-generic-password -U -s " + keyringService + " -a " + name + " -w " + shellQuote(secret) + "\n")
		if out, err := cmd.CombinedOutput(); err != nil || bytes.Contains(out, []byte("error")) {
			return errors.New("no pude guardar en el Llavero de macOS")
		}
		return nil
	default:
		if _, err := exec.LookPath("secret-tool"); err != nil {
			return errNoKeyring
		}
		cmd := exec.Command("secret-tool", "store", "--label=apus: "+name, "service", keyringService, "account", name)
		cmd.Stdin = strings.NewReader(secret)
		if err := cmd.Run(); err != nil {
			return errors.New("no pude guardar en el llavero del sistema (secret-tool)")
		}
		return nil
	}
}

func keyringGet(name string) (string, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("security", "find-generic-password", "-s", keyringService, "-a", name, "-w")
	default:
		if _, err := exec.LookPath("secret-tool"); err != nil {
			return "", errNoKeyring
		}
		cmd = exec.Command("secret-tool", "lookup", "service", keyringService, "account", name)
	}
	out, err := cmd.Output()
	secret := strings.TrimRight(string(out), "\r\n")
	if err != nil || secret == "" {
		return "", errNoSecret
	}
	return secret, nil
}

func keyringDelete(name string) error {
	switch runtime.GOOS {
	case "darwin":
		exec.Command("security", "delete-generic-password", "-s", keyringService, "-a", name).Run()
	default:
		if _, err := exec.LookPath("secret-tool"); err != nil {
			return errNoKeyring
		}
		exec.Command("secret-tool", "clear", "service", keyringService, "account", name).Run()
	}
	return nil
}

// shellQuote arma un argumento para la línea de comandos de security -i.
func shellQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}
