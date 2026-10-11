//go:build windows

package main

import (
	"errors"
	"strconv"
	"testing"
	"time"
)

// Ida y vuelta por el Administrador de credenciales, con un nombre propio de
// la prueba: el token de verdad ("apus:github") no se toca.
func TestKeyringWindows(t *testing.T) {
	name := "test-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	defer keyringDelete(name)

	if _, err := keyringGet(name); !errors.Is(err, errNoSecret) {
		t.Fatalf("sin guardar, tenía que decir que no hay: %v", err)
	}
	secret := "ghp_" + name + "_ñandú"
	if err := keyringSet(name, secret); err != nil {
		t.Fatal(err)
	}
	if got, err := keyringGet(name); err != nil || got != secret {
		t.Fatalf("leí %q (%v), guardé %q", got, err, secret)
	}
	if err := keyringDelete(name); err != nil {
		t.Fatal(err)
	}
	if _, err := keyringGet(name); !errors.Is(err, errNoSecret) {
		t.Fatalf("después de borrar, tenía que decir que no hay: %v", err)
	}
	if err := keyringDelete(name); err != nil {
		t.Fatalf("borrar dos veces no es un error: %v", err)
	}
}
