package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// GHRepo es un repo de tu cuenta, tal como lo devuelve `gh repo list --json`.
type GHRepo struct {
	NameWithOwner string    `json:"nameWithOwner"`
	Visibility    string    `json:"visibility"`
	URL           string    `json:"url"`
	SSHURL        string    `json:"sshUrl"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// Name es la parte de la derecha: el nombre sin el dueño.
func (g GHRepo) Name() string {
	_, name, found := strings.Cut(g.NameWithOwner, "/")
	if !found {
		return g.NameWithOwner
	}
	return name
}

// CloneURL devuelve la URL según el protocolo configurado en gh.
func (g GHRepo) CloneURL() string {
	if ghProtocol() == "ssh" {
		return g.SSHURL
	}
	return g.URL
}

func (g GHRepo) Meta() string {
	vis := strings.ToLower(g.Visibility)
	if g.UpdatedAt.IsZero() {
		return vis
	}
	return vis + "  " + g.UpdatedAt.Local().Format("2006-01-02")
}

func gh(args ...string) (string, error) {
	cmd := exec.Command("gh", args...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	// gh en modo no interactivo: que no intente abrir un navegador ni preguntar.
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1")
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return strings.TrimSpace(out.String()), errors.New(msg)
	}
	return strings.TrimSpace(out.String()), nil
}

func ghAvailable() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

// ghReady dice si además de estar instalado, tiene sesión iniciada.
func ghReady() bool {
	if !ghAvailable() {
		return false
	}
	_, err := gh("auth", "status")
	return err == nil
}

// ghProtocol respeta lo que el usuario ya eligió en gh (https o ssh).
func ghProtocol() string {
	if out, err := gh("config", "get", "git_protocol"); err == nil && strings.TrimSpace(out) == "ssh" {
		return "ssh"
	}
	return "https"
}

func ghUser() (string, error) {
	return gh("api", "user", "--jq", ".login")
}

// ghList trae los repos de tu cuenta, del más reciente al más viejo.
func ghList() ([]GHRepo, error) {
	out, err := gh("repo", "list", "--limit", "200",
		"--json", "nameWithOwner,visibility,url,sshUrl,updatedAt")
	if err != nil {
		return nil, err
	}
	var repos []GHRepo
	if err := json.Unmarshal([]byte(out), &repos); err != nil {
		return nil, err
	}
	return repos, nil
}

// ghCreate crea el repo en GitHub y devuelve su nombre completo y su URL de git.
func ghCreate(name, visibility string) (full, url string, err error) {
	if visibility != "public" {
		visibility = "private"
	}
	if _, err = gh("repo", "create", name, "--"+visibility); err != nil {
		return "", "", err
	}
	owner, repo, found := strings.Cut(name, "/")
	if !found {
		repo = name
		if owner, err = ghUser(); err != nil {
			return "", "", errors.New("no pude averiguar tu usuario de GitHub: " + err.Error())
		}
	}
	full = owner + "/" + repo
	if ghProtocol() == "ssh" {
		url = "git@github.com:" + full + ".git"
	} else {
		url = "https://github.com/" + full + ".git"
	}
	return full, url, nil
}

var shorthandRe = regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`)

// normalizeRemote acepta una URL completa, el atajo usuario/repo, o la ruta a
// un repo local, y devuelve algo que git entienda como remoto.
func normalizeRemote(input string) (string, error) {
	in := strings.TrimSpace(input)
	if in == "" {
		return "", errors.New("no ingresaste nada")
	}
	if strings.Contains(in, "://") || (strings.HasPrefix(in, "git@") && strings.Contains(in, ":")) {
		return in, nil
	}
	if shorthandRe.MatchString(in) {
		if ghProtocol() == "ssh" {
			return "git@github.com:" + in + ".git", nil
		}
		return "https://github.com/" + in + ".git", nil
	}
	if st, err := os.Stat(in); err == nil && st.IsDir() {
		return in, nil // un repo local también es un remoto válido
	}
	return "", errors.New("no entiendo '" + in + "': pegá una URL completa o usá usuario/repo")
}

// setRemote deja el remoto apuntando a url, creándolo si no existía.
func setRemote(root, name, url string) error {
	if gitOK(root, "remote", "get-url", name) {
		_, err := git(root, "remote", "set-url", name, url)
		return err
	}
	_, err := git(root, "remote", "add", name, url)
	return err
}
