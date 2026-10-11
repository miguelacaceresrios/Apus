//go:build windows

package main

import (
	"errors"
	"syscall"
	"unsafe"
)

// El token vive en el Administrador de credenciales de Windows, cifrado con la
// cuenta del usuario. apus nunca lo escribe en un archivo.

var (
	advapi32       = syscall.NewLazyDLL("advapi32.dll")
	credWriteW     = advapi32.NewProc("CredWriteW")
	credReadW      = advapi32.NewProc("CredReadW")
	credDeleteW    = advapi32.NewProc("CredDeleteW")
	credFree       = advapi32.NewProc("CredFree")
	errNoCredEntry = syscall.Errno(1168) // ERROR_NOT_FOUND
)

const (
	credTypeGeneric     = 1
	credPersistLocalMax = 2 // CRED_PERSIST_LOCAL_MACHINE: sobrevive al reinicio, no viaja con el perfil
)

// credential es CREDENTIALW, con la misma disposición en memoria.
type credential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        syscall.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

func keyringSet(name, secret string) error {
	target, err := syscall.UTF16PtrFromString(keyringService + ":" + name)
	if err != nil {
		return err
	}
	user, _ := syscall.UTF16PtrFromString(name)
	blob := []byte(secret)
	c := credential{
		Type:               credTypeGeneric,
		TargetName:         target,
		CredentialBlobSize: uint32(len(blob)),
		Persist:            credPersistLocalMax,
		UserName:           user,
	}
	if len(blob) > 0 {
		c.CredentialBlob = &blob[0]
	}
	if r, _, e := credWriteW.Call(uintptr(unsafe.Pointer(&c)), 0); r == 0 {
		return errors.New("no pude guardar en el Administrador de credenciales: " + e.Error())
	}
	return nil
}

func keyringGet(name string) (string, error) {
	target, err := syscall.UTF16PtrFromString(keyringService + ":" + name)
	if err != nil {
		return "", err
	}
	var pc *credential
	if r, _, e := credReadW.Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0, uintptr(unsafe.Pointer(&pc))); r == 0 {
		if e == errNoCredEntry {
			return "", errNoSecret
		}
		return "", errors.New("no pude leer el Administrador de credenciales: " + e.Error())
	}
	defer credFree.Call(uintptr(unsafe.Pointer(pc)))
	if pc.CredentialBlobSize == 0 {
		return "", errNoSecret
	}
	return string(unsafe.Slice(pc.CredentialBlob, pc.CredentialBlobSize)), nil
}

func keyringDelete(name string) error {
	target, err := syscall.UTF16PtrFromString(keyringService + ":" + name)
	if err != nil {
		return err
	}
	if r, _, e := credDeleteW.Call(uintptr(unsafe.Pointer(target)), credTypeGeneric, 0); r == 0 && e != errNoCredEntry {
		return errors.New("no pude borrar del Administrador de credenciales: " + e.Error())
	}
	return nil
}
