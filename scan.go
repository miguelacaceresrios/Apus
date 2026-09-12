package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// carpetas que no tiene sentido recorrer buscando repos
var skipDirs = map[string]bool{
	"node_modules": true, "vendor": true, "target": true, "dist": true,
	"build": true, "__pycache__": true, "venv": true, ".venv": true,
	"Library": true, "AppData": true,
}

// repoBases decide dónde buscar repos: las carpetas que te pasen, si no
// APUS_REPOS_DIR, si no el directorio actual.
func repoBases(dirs []string) []string {
	if len(dirs) > 0 {
		return dirs
	}
	if v := os.Getenv("APUS_REPOS_DIR"); v != "" {
		var out []string
		for _, p := range filepath.SplitList(v) {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, expandHome(p))
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	return []string{cwd}
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

// findRepos recorre las carpetas base buscando repositorios y lee el estado de
// cada uno. No entra dentro de un repo: si una carpeta tiene .git, es hoja.
func findRepos(bases []string, maxDepth int) []*Repo {
	found := map[string]bool{}
	var paths []string
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if st, err := os.Stat(filepath.Join(dir, ".git")); err == nil && (st.IsDir() || st.Mode().IsRegular()) {
			clean := filepath.Clean(dir)
			if !found[clean] {
				found[clean] = true
				paths = append(paths, clean)
			}
			return
		}
		if depth >= maxDepth {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasPrefix(name, ".") || skipDirs[name] {
				continue
			}
			walk(filepath.Join(dir, name), depth+1)
		}
	}
	for _, b := range bases {
		walk(expandHome(b), 0)
	}

	repos := make([]*Repo, len(paths))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, p := range paths {
		wg.Add(1)
		go func(i int, p string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if r, err := LoadRepo(p); err == nil {
				repos[i] = r
			}
		}(i, p)
	}
	wg.Wait()

	var out []*Repo
	for _, r := range repos {
		if r != nil {
			out = append(out, r)
		}
	}
	// Primero lo que reclama atención, después alfabético.
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := priority(out[i]), priority(out[j])
		if pi != pj {
			return pi < pj
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func priority(r *Repo) int {
	switch {
	case r.Dirty():
		return 0
	case r.Ahead > 0, r.Upstream == "" && r.HasHead:
		return 1
	default:
		return 2
	}
}

// icon resume el estado en un caracter, para listas y para la barra.
func icon(r *Repo) string {
	switch {
	case r.Dirty():
		return "●"
	case r.Ahead > 0:
		return "↑"
	case r.Upstream == "" && r.HasHead:
		return "⚲"
	default:
		return "○"
	}
}

func cmdStatus(args []string) int {
	var dirs []string
	asJSON := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			asJSON = true
		case "--dir":
			if i+1 >= len(args) {
				return dieMsg(codeUsage, "--dir necesita una ruta", "")
			}
			i++
			dirs = append(dirs, args[i])
		case "-q", "--quiet":
			quiet = true
		default:
			return dieMsg(codeUsage, "opción desconocida: "+args[i], "probá 'apus --help'")
		}
	}

	repos := findRepos(repoBases(dirs), 3)

	if asJSON {
		// Formato de módulo custom de Waybar.
		pending := 0
		var lines []string
		for _, r := range repos {
			if priority(r) < 2 {
				pending++
				lines = append(lines, fmt.Sprintf("%s %s — %s", icon(r), r.Name, r.Summary()))
			}
		}
		out := map[string]string{"class": "clean", "text": "○", "tooltip": "todo al día"}
		if pending > 0 {
			out["class"] = "dirty"
			out["text"] = fmt.Sprintf("● %d", pending)
			out["tooltip"] = strings.Join(lines, "\n")
		}
		b, _ := json.Marshal(out)
		fmt.Println(string(b))
		return codeOK
	}

	if len(repos) == 0 {
		warnMsg("no encontré repos en: " + strings.Join(repoBases(dirs), ", "))
		return codeOK
	}
	for _, r := range repos {
		fmt.Printf("%s %-28s %s\n", icon(r), r.Name, r.Summary())
	}
	return codeOK
}
