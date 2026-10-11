package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// El log de apus-guard: un archivo JSON por máquina con cada hallazgo que se
// vio, su estado y cuándo. Lo escribe apus-guard y lo lee y edita Aerodramus.
// No tiene el secreto: solo el valor y la línea tapados, igual que la ventana.

const (
	statusPending  = "pending"
	statusResolved = "resolved"
	statusIgnored  = "ignored"
)

// Entry es un hallazgo en el log.
type Entry struct {
	Repo        string `json:"repo"`             // la carpeta del repo, absoluta
	Remote      string `json:"remote,omitempty"` // URL del remoto, sin usuario ni token
	ID          string `json:"id"`               // hash de archivo + línea + regla
	Fingerprint string `json:"fingerprint"`      // hash de archivo + regla + línea tapada: sobrevive si la línea se mueve
	Rule        string `json:"rule"`
	Severity    string `json:"severity"`
	File        string `json:"file"`
	Line        int    `json:"line"`
	Title       string `json:"title"`
	Key         string `json:"key,omitempty"`
	Redacted    string `json:"redacted"`
	Snippet     string `json:"snippet"`
	Fix         string `json:"fix"`
	Status      string `json:"status"`
	Auto        bool   `json:"auto,omitempty"` // lo resolvió apus-guard al ver que ya no está
	FirstSeen   string `json:"firstSeen"`
	LastSeen    string `json:"lastSeen"`
	Changed     string `json:"changed"` // cuándo cambió de estado
	Issue       string `json:"issue,omitempty"`
}

type ledgerFile struct {
	Version int      `json:"version"`
	Entries []*Entry `json:"entries"`
}

// ledgerPath es el archivo del log: uno por máquina y usuario, fuera de los
// repos para que nunca se suba. APUS_LOG lo cambia (las pruebas lo usan).
func ledgerPath() string {
	if p := os.Getenv("APUS_LOG"); p != "" {
		return p
	}
	var dir string
	switch runtime.GOOS {
	case "windows":
		dir = os.Getenv("LOCALAPPDATA")
	case "darwin":
		dir, _ = os.UserConfigDir()
	default:
		dir = os.Getenv("XDG_STATE_HOME")
		if dir == "" {
			if home, err := os.UserHomeDir(); err == nil {
				dir = filepath.Join(home, ".local", "state")
			}
		}
	}
	if dir == "" {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "apus", "guard-log.json")
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func fingerprint(f Finding) string {
	sum := sha256.Sum256([]byte(f.File + "\x00" + f.Rule + "\x00" + f.Snippet))
	return hex.EncodeToString(sum[:6])
}

// withLedger abre el log con un candado, deja que fn lo cambie y lo guarda. El
// candado es un archivo al lado: apus y Aerodramus pueden escribir a la vez.
// Si fn devuelve false, no se escribe nada.
func withLedger(fn func(l *ledgerFile) bool) error {
	path := ledgerPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	unlock, err := lockFile(path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()

	l, err := readLedger(path)
	if err != nil {
		return err
	}
	if !fn(l) {
		return nil
	}
	data, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	// Primero a un temporal y después el renombre: un corte a la mitad no deja
	// el log roto.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readLedger(path string) (*ledgerFile, error) {
	l := &ledgerFile{Version: 1}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return l, nil
	}
	if err := json.Unmarshal(data, l); err != nil {
		// Un log ilegible no se pisa: se guarda aparte y se empieza de nuevo.
		os.Rename(path, path+".roto-"+time.Now().Format("20060102-150405"))
		return &ledgerFile{Version: 1}, nil
	}
	return l, nil
}

// loadLedger lee el log sin candado, para mostrarlo.
func loadLedger() (*ledgerFile, error) {
	return readLedger(ledgerPath())
}

// lockFile toma el candado creando el archivo en exclusiva. Si otro proceso lo
// dejó tirado (se cortó en el medio), a los 10 segundos se considera vencido.
func lockFile(path string) (func(), error) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if st, serr := os.Stat(path); serr == nil && time.Since(st.ModTime()) > 10*time.Second {
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("el log de apus-guard está ocupado por otro proceso")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func sameRepo(a, b string) bool { return samePath(a, b) }

// ignoredIn devuelve los hallazgos ignorados de un repo, por ID y por huella.
func ignoredIn(l *ledgerFile, repo string) (ids, prints map[string]bool) {
	ids, prints = map[string]bool{}, map[string]bool{}
	for _, e := range l.Entries {
		if e.Status == statusIgnored && sameRepo(e.Repo, repo) {
			ids[e.ID] = true
			prints[e.Fingerprint] = true
		}
	}
	return ids, prints
}

// recordScan anota en el log lo que encontró apus-guard en un repo y devuelve
// los hallazgos sin los ignorados. scanned son los archivos que se revisaron:
// un hallazgo pendiente de esos archivos que ya no aparece se da por resuelto
// (de los que no se revisaron no se sabe nada, y no se tocan).
func recordScan(repo, remote string, fs []Finding, scanned []string) (kept []Finding, ignored int, err error) {
	remote = browseURL(remote)
	seenFiles := map[string]bool{}
	for _, f := range scanned {
		seenFiles[filepathToSlash(f)] = true
	}
	err = withLedger(func(l *ledgerFile) bool {
		ids, prints := ignoredIn(l, repo)
		byID := map[string]*Entry{}
		for _, e := range l.Entries {
			if sameRepo(e.Repo, repo) {
				byID[e.ID] = e
			}
		}
		t := now()
		found := map[string]bool{}
		for _, f := range fs {
			fp := fingerprint(f)
			if ids[f.ID] || prints[fp] {
				ignored++
				if e := byID[f.ID]; e != nil && e.Status == statusIgnored {
					e.LastSeen = t
				}
				continue
			}
			kept = append(kept, f)
			found[f.ID] = true
			e := byID[f.ID]
			if e == nil {
				e = &Entry{Repo: repo, ID: f.ID, FirstSeen: t, Status: statusPending, Changed: t}
				l.Entries = append(l.Entries, e)
				byID[f.ID] = e
			} else if e.Status == statusResolved {
				// Volvió a aparecer: vuelve a estar pendiente.
				e.Status, e.Auto, e.Changed = statusPending, false, t
			}
			e.Remote, e.Fingerprint, e.Rule, e.Severity = remote, fp, f.Rule, f.Severity
			e.File, e.Line, e.Title, e.Key = f.File, f.Line, f.Title, f.Key
			e.Redacted, e.Snippet, e.Fix, e.LastSeen = f.Redacted, f.Snippet, f.Fix, t
		}
		for _, e := range l.Entries {
			if e.Status == statusPending && sameRepo(e.Repo, repo) && !found[e.ID] && seenFiles[e.File] {
				e.Status, e.Auto, e.Changed = statusResolved, true, t
			}
		}
		return true
	})
	return kept, ignored, err
}

func filepathToSlash(p string) string { return filepath.ToSlash(p) }

// recordIssues guarda en el log el issue de cada hallazgo.
func recordIssues(repo string, refs []IssueRef) error {
	if len(refs) == 0 {
		return nil
	}
	return withLedger(func(l *ledgerFile) bool {
		urls := map[string]string{}
		for _, r := range refs {
			urls[r.Finding] = r.URL
		}
		for _, e := range l.Entries {
			if u, ok := urls[e.ID]; ok && sameRepo(e.Repo, repo) {
				e.Issue = u
			}
		}
		return true
	})
}

// setStatus cambia el estado de un hallazgo, desde Aerodramus.
func setStatus(repo, id, status string) (*Entry, error) {
	switch status {
	case statusPending, statusResolved, statusIgnored:
	default:
		return nil, errors.New("estado desconocido: " + status)
	}
	var found *Entry
	err := withLedger(func(l *ledgerFile) bool {
		for _, e := range l.Entries {
			if e.ID == id && sameRepo(e.Repo, repo) {
				if e.Status != status {
					e.Status, e.Auto, e.Changed = status, false, now()
				}
				c := *e
				found = &c
				return true
			}
		}
		return false
	})
	if err == nil && found == nil {
		err = errors.New("ese hallazgo ya no está en el log")
	}
	return found, err
}

// sortedEntries ordena para mostrar: por repo, después críticos y pendientes
// primero, después archivo y línea.
func sortedEntries(es []*Entry) []*Entry {
	out := append([]*Entry(nil), es...)
	rank := map[string]int{statusPending: 0, statusIgnored: 1, statusResolved: 2}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if !sameRepo(a.Repo, b.Repo) {
			return strings.ToLower(a.Repo) < strings.ToLower(b.Repo)
		}
		if rank[a.Status] != rank[b.Status] {
			return rank[a.Status] < rank[b.Status]
		}
		if a.Severity != b.Severity {
			return a.Severity == sevCritical
		}
		if a.File != b.File {
			return a.File < b.File
		}
		return a.Line < b.Line
	})
	return out
}
