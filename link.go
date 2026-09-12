package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// linkInteractive deja el repo con un remoto configurado, preguntando en la
// terminal. Devuelve el nombre del remoto ("origin").
func linkInteractive(r *Repo, dryRun bool) (string, error) {
	var repos []GHRepo
	switch {
	case ghReady():
		if list, err := ghList(); err == nil {
			repos = list
		} else {
			warnMsg("no pude listar tus repos: " + firstLine(err.Error()))
		}
	case ghAvailable():
		warnMsg("gh está instalado pero sin sesión: corré 'gh auth login' para elegir de tus repos")
	default:
		warnMsg("gh no está instalado: por ahora sólo puedo tomar una URL (instalalo para elegir de tu cuenta)")
	}

	var url, label string
	var err error
	if len(repos) == 0 && !ghReady() {
		url, label, err = askRemoteURL()
	} else {
		url, label, err = chooseGHRepo(repos, r.Name)
	}
	if err != nil {
		return "", err
	}

	step("git remote add origin " + url)
	if !dryRun {
		if err := setRemote(r.Path, "origin", url); err != nil {
			return "", fail(codeRepo, "no pude configurar el remoto: %s", firstLine(err.Error()))
		}
	}
	r.Remote = "origin"
	r.RemoteURL = url
	okMsg("origin → " + label)
	return "origin", nil
}

// chooseGHRepo muestra el menú de repos y devuelve la URL elegida.
func chooseGHRepo(repos []GHRepo, folder string) (url, label string, err error) {
	// El repo que se llama igual que la carpeta queda preseleccionado.
	def := "n"
	for i, g := range repos {
		if g.Name() == folder {
			def = strconv.Itoa(i + 1)
			break
		}
	}

	filter := ""
	for {
		if len(repos) > 0 {
			title := "  " + paint("1", "tus repos")
			if filter != "" {
				title += paint("2", " (filtro: "+filter+")")
			}
			fmt.Fprintln(os.Stderr, "\n"+title)
			shown := 0
			for i, g := range repos {
				if filter != "" && !strings.Contains(strings.ToLower(g.NameWithOwner), strings.ToLower(filter)) {
					continue
				}
				if shown >= 15 {
					fmt.Fprintln(os.Stderr, paint("2", "  … hay más: filtrá escribiendo /texto"))
					break
				}
				fmt.Fprintf(os.Stderr, "  %3d) %-34s %s\n", i+1, g.NameWithOwner, paint("2", g.Meta()))
				shown++
			}
			if shown == 0 {
				fmt.Fprintln(os.Stderr, paint("2", "  (ningún repo coincide con '"+filter+"')"))
			}
		}
		fmt.Fprintln(os.Stderr, "    "+paint("1", "n")+") crear un repo nuevo en GitHub")
		fmt.Fprintln(os.Stderr, "    "+paint("1", "u")+") pegar una URL")
		fmt.Fprintln(os.Stderr, "    "+paint("1", "q")+") cancelar")

		choice, err := ask("elegí", def)
		if err != nil {
			return "", "", err
		}
		choice = strings.TrimSpace(choice)

		switch {
		case strings.HasPrefix(choice, "/"):
			filter = strings.TrimPrefix(choice, "/")
			continue
		case choice == "q" || choice == "Q":
			return "", "", fail(codeRepo, "vinculación cancelada")
		case choice == "n" || choice == "N":
			url, label, err = createGHRepo(folder)
			if err != nil {
				warnMsg(err.Error())
				warnMsg("probá de nuevo")
				continue
			}
			return url, label, nil
		case choice == "u" || choice == "U":
			url, label, err = askRemoteURL()
			if err != nil {
				if f, ok := err.(*Fail); ok && f.Code == codeRepo && strings.Contains(f.Msg, "nadie del otro lado") {
					return "", "", err
				}
				warnMsg(err.Error())
				warnMsg("probá de nuevo")
				continue
			}
			return url, label, nil
		}

		n, convErr := strconv.Atoi(choice)
		if convErr != nil {
			warnMsg("no entiendo '" + choice + "'")
			continue
		}
		if n < 1 || n > len(repos) {
			warnMsg("el " + choice + " no está en la lista")
			continue
		}
		g := repos[n-1]
		return g.CloneURL(), g.NameWithOwner, nil
	}
}

// createGHRepo crea el repo nuevo preguntando nombre y visibilidad.
func createGHRepo(suggested string) (url, label string, err error) {
	if !ghReady() {
		return "", "", fmt.Errorf("para crear el repo necesitás gh con sesión iniciada: 'gh auth login'")
	}
	name, err := ask("nombre del repo nuevo", suggested)
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(name) == "" {
		return "", "", fmt.Errorf("nombre vacío")
	}
	vis, err := ask("visibilidad", "private")
	if err != nil {
		return "", "", err
	}
	switch strings.ToLower(strings.TrimSpace(vis)) {
	case "private", "priv", "p":
		vis = "private"
	case "public", "pub", "pu":
		vis = "public"
	default:
		return "", "", fmt.Errorf("visibilidad desconocida: '%s' (private o public)", vis)
	}
	step("gh repo create " + name + " --" + vis)
	full, url, err := ghCreate(strings.TrimSpace(name), vis)
	if err != nil {
		return "", "", fmt.Errorf("gh no pudo crear el repo: %s", firstLine(err.Error()))
	}
	return url, full, nil
}

// askRemoteURL pide una URL, un atajo usuario/repo o una ruta local.
func askRemoteURL() (url, label string, err error) {
	input, err := ask("URL del repo (o usuario/repo)", "")
	if err != nil {
		return "", "", err
	}
	url, uerr := normalizeRemote(input)
	if uerr != nil {
		return "", "", uerr
	}
	label = browseURL(url)
	if label == "" {
		label = url
	} else {
		label = strings.TrimPrefix(label, "https://")
	}
	return url, label, nil
}
