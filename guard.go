package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// apus-guard busca credenciales escritas en los archivos que se van a subir.
// Las reglas son fijas y a propósito: SQL Server, Azure Storage, Service Bus y
// Event Hubs, y las claves con nombre de secreto de un appsettings.json. Nada
// de reglas configurables.
//
// El secreto nunca sale de acá entero: cada hallazgo lleva un prefijo corto y
// asteriscos, y la línea que se muestra tiene todos sus secretos tapados.

const (
	sevCritical = "critical"
	sevWarning  = "warning"
)

// Finding es un hallazgo. Lo que se serializa es seguro de mostrar y de mandar
// a GitHub; el valor completo queda en secret, que no se serializa.
type Finding struct {
	ID       string `json:"id"`       // archivo + línea + regla, para no repetir issues ni comentarios
	Rule     string `json:"rule"`     // sql-password, azure-account-key…
	Severity string `json:"severity"` // critical o warning
	File     string `json:"file"`     // relativo al repo, con /
	Line     int    `json:"line"`
	Title    string `json:"title"`
	Key      string `json:"key,omitempty"` // la clave de configuración, si viene de un appsettings
	Redacted string `json:"redacted"`      // el valor, tapado
	Snippet  string `json:"snippet"`       // la línea, con los secretos tapados
	Fix      string `json:"fix"`           // qué hacer, concreto

	secret string
}

// Marca para ignorar una línea a mano: `// apus-guard:ignore`. Es la salida
// para un falso positivo, no una regla nueva.
const ignoreMark = "apus-guard:ignore"

// La clave pública del emulador de Storage (Azurite): está en la documentación
// de Microsoft y no abre nada real.
const azuriteKey = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="

// ─── qué archivos se miran ──────────────────────────────────────────────────

func isAppSettings(name string) bool {
	n := strings.ToLower(path.Base(name))
	return strings.HasPrefix(n, "appsettings") && strings.HasSuffix(n, ".json")
}

// Las claves de Azure pueden aparecer en cualquier archivo de texto de un
// proyecto: estos son los que se revisan además de appsettings y .cs.
var textExts = map[string]bool{
	".json": true, ".config": true, ".xml": true, ".yml": true, ".yaml": true,
	".env": true, ".ini": true, ".properties": true, ".ps1": true, ".psm1": true,
	".sh": true, ".bash": true, ".bicep": true, ".bicepparam": true, ".tf": true,
	".tfvars": true, ".js": true, ".ts": true, ".py": true, ".csx": true,
	".cshtml": true, ".razor": true, ".txt": true,
}

func wantsScan(name string) bool {
	base := strings.ToLower(path.Base(name))
	ext := path.Ext(base)
	return isAppSettings(base) || ext == ".cs" || textExts[ext] || strings.HasPrefix(base, ".env")
}

const maxScanSize = 1 << 20

// ─── reglas ─────────────────────────────────────────────────────────────────

// placeholder dice si un valor es de relleno y no un secreto de verdad. Mira el
// contexto del valor (cómo está escrito), no solo cuán aleatorio parece.
func placeholder(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return true
	}
	// todo el mismo caracter: xxxx, ****, 0000
	if r := []rune(v); strings.Count(v, string(r[0])) == len(r) {
		return true
	}
	// variables y tokens que reemplaza otra herramienta: <pwd>, {pwd}, ${PWD},
	// $(PWD), %PWD%, #{Pwd}#, __Pwd__
	pairs := [][2]string{{"<", ">"}, {"{", "}"}, {"[", "]"}, {"${", "}"}, {"$(", ")"}, {"%", "%"}, {"#{", "}#"}, {"__", "__"}}
	for _, p := range pairs {
		if len(v) > len(p[0])+len(p[1]) && strings.HasPrefix(v, p[0]) && strings.HasSuffix(v, p[1]) {
			return true
		}
	}
	lower := strings.ToLower(v)
	for _, p := range []string{"@microsoft.keyvault(", "env:", "$env:", "keyvault:", "vault:"} {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	flat := strings.NewReplacer("-", "", "_", "", " ", "", ".", "").Replace(lower)
	// Las palabras largas cuentan en cualquier parte; las cortas, solo al
	// principio: "tbd" o "xxx" pueden salir por azar dentro de una clave real.
	for _, w := range []string{
		"changeme", "replaceme", "replacewith", "placeholder", "example", "dummy", "fixme",
		"notset", "redacted", "sample", "secretgoeshere", "usersecrets", "fromkeyvault",
	} {
		if strings.Contains(flat, w) {
			return true
		}
	}
	for _, w := range []string{"your", "todo", "tbd", "xxx", "setme", "insert", "enter"} {
		if strings.HasPrefix(flat, w) {
			return true
		}
	}
	switch flat {
	case "none", "null", "nil", "undefined", "empty", "secret", "password", "token", "apikey", "string", "value":
		return true
	}
	return false
}

// connPairs parte un connection string en claves (en minúscula) y valores.
// Devuelve nil si no parece uno.
func connPairs(s string) map[string]string {
	if !strings.Contains(s, "=") || !strings.Contains(s, ";") && strings.Count(s, "=") < 2 {
		return nil
	}
	out := map[string]string{}
	for _, part := range strings.Split(s, ";") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		k = strings.ToLower(strings.Join(strings.Fields(k), " "))
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '\'' || v[0] == '"') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		if k != "" {
			out[k] = v
		}
	}
	if len(out) < 2 {
		return nil
	}
	return out
}

func first(m map[string]string, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v, true
		}
	}
	return "", false
}

var (
	serverKeys   = []string{"server", "data source", "datasource", "addr", "address", "network address"}
	passwordKeys = []string{"password", "pwd"}
	userKeys     = []string{"user id", "userid", "uid", "user", "username", "user name"}
	databaseKeys = []string{"database", "initial catalog"}
)

// sqlConn dice si los pares son de un connection string de SQL Server: con
// servidor, o con contraseña y base o usuario (el resto de un string armado
// en partes).
func sqlConn(p map[string]string) bool {
	if _, ok := p["accountname"]; ok {
		return false // Storage
	}
	if v, ok := p["endpoint"]; ok && strings.HasPrefix(strings.ToLower(v), "sb://") {
		return false // Service Bus / Event Hubs
	}
	_, server := first(p, serverKeys...)
	_, pwd := first(p, passwordKeys...)
	_, db := first(p, databaseKeys...)
	_, user := first(p, userKeys...)
	return server && (pwd || db || user) || pwd && (db || user)
}

// Sin contraseña a la vista: con Windows o con Entra ID, el string no guarda credenciales.
func passwordless(p map[string]string) bool {
	yes := func(v string) bool {
		v = strings.ToLower(v)
		return v == "true" || v == "yes" || v == "sspi"
	}
	if yes(p["integrated security"]) || yes(p["trusted_connection"]) {
		return true
	}
	auth := strings.ToLower(p["authentication"])
	return strings.Contains(auth, "active directory") && !strings.Contains(auth, "password")
}

// Los arreglos. key es la clave de configuración ("ConnectionStrings:Default"),
// para que el comando sugerido se pueda copiar tal cual.
func fixSQL(key string) string {
	k := key
	if k == "" {
		k = "ConnectionStrings:Default"
	}
	return "Sacá la contraseña del archivo. En desarrollo: `dotnet user-secrets set \"" + k + "\" \"<connection string>\"`. " +
		"En producción: la variable de entorno `" + strings.ReplaceAll(k, ":", "__") + "` o un secreto en Azure Key Vault. " +
		"En Azure, mejor sin contraseña: Managed Identity (`Authentication=Active Directory Default`). Si ya estuvo en un commit, cambiala."
}

func fixSQLUser(key string) string {
	return "El usuario de la base está escrito en el archivo. Movelo junto con la contraseña: `dotnet user-secrets` en desarrollo, " +
		"variable de entorno o Azure Key Vault en producción (" + strings.ReplaceAll(orDefault(key, "ConnectionStrings:Default"), ":", "__") + "), o usá Managed Identity y no hace falta usuario."
}

const fixStorage = "Clave de Azure Storage: en código usá Managed Identity con `DefaultAzureCredential` y la URL de la cuenta, sin clave. " +
	"Si necesitás el connection string, guardalo en Azure Key Vault y en desarrollo con `dotnet user-secrets`. Rotá la clave en el portal (Storage account → Access keys): ya estuvo en tu disco."

const fixServiceBus = "Clave de Service Bus / Event Hubs: usá Managed Identity (`DefaultAzureCredential`) con el nombre del namespace, sin clave. " +
	"Si necesitás el connection string, guardalo en Azure Key Vault y en desarrollo con `dotnet user-secrets`. Regenerá la clave en el portal (Shared access policies)."

func fixKey(key string) string {
	return "En desarrollo: `dotnet user-secrets set \"" + key + "\" \"<valor>\"`. En producción: la variable de entorno `" +
		strings.ReplaceAll(key, ":", "__") + "` o Azure Key Vault (`builder.Configuration.AddAzureKeyVault(...)`). " +
		"En appsettings.json dejá el valor vacío. Si ya estuvo en un commit, rotalo."
}

func fixClientID(key string) string {
	return "Un ClientId no es secreto por sí solo, pero viaja con el ClientSecret y cambia por ambiente: movelo a `dotnet user-secrets` " +
		"o a la variable de entorno `" + strings.ReplaceAll(key, ":", "__") + "`."
}

const fixCS = "No armes el connection string en el código: leelo de la configuración con `builder.Configuration.GetConnectionString(\"Default\")` " +
	"y guardalo con `dotnet user-secrets` en desarrollo, o en una variable de entorno o Azure Key Vault en producción."

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// hit es un hallazgo antes de armar el Finding: la línea y el valor completo.
type hit struct {
	rule, severity, title, key, fix, value string
	line                                   int
}

// connHits aplica las reglas de connection strings a un valor. file es para
// saber qué reglas de SQL corren: en appsettings sí, en .cs con las suyas.
func connHits(value, key string, line int, cs bool) []hit {
	p := connPairs(value)
	if p == nil {
		return nil
	}
	var out []hit
	if v, ok := p["accountkey"]; ok && !placeholder(v) && v != azuriteKey {
		out = append(out, hit{rule: "azure-account-key", severity: sevCritical, title: "Clave de Azure Storage (AccountKey)", key: key, fix: fixStorage, value: v, line: line})
	}
	if v, ok := p["sharedaccesskey"]; ok && !placeholder(v) {
		out = append(out, hit{rule: "azure-shared-access-key", severity: sevCritical, title: "Clave de Service Bus / Event Hubs (SharedAccessKey)", key: key, fix: fixServiceBus, value: v, line: line})
	}
	if !sqlConn(p) || passwordless(p) {
		return out
	}
	pwd, hasPwd := first(p, passwordKeys...)
	user, hasUser := first(p, userKeys...)
	switch {
	case hasPwd && !placeholder(pwd):
		rule, fix := "sql-password", fixSQL(key)
		if cs {
			rule, fix = "cs-sql-password", fixCS
		}
		out = append(out, hit{rule: rule, severity: sevCritical, title: "Contraseña de SQL Server en un connection string", key: key, fix: fix, value: pwd, line: line})
	case cs:
		out = append(out, hit{rule: "cs-connection-string", severity: sevWarning, title: "Connection string de SQL Server armado en el código", fix: fixCS, value: value, line: line})
	case hasUser && !placeholder(user):
		out = append(out, hit{rule: "sql-user", severity: sevWarning, title: "Usuario de SQL Server en un connection string", key: key, fix: fixSQLUser(key), value: user, line: line})
	}
	return out
}

// Las claves de configuración que por su nombre guardan un secreto…
var secretWords = []string{"apikey", "clientsecret", "secret", "token", "password", "passwd", "accesskey", "privatekey"}

// …salvo que el nombre diga que es otra cosa: el nombre del secreto, su URL,
// cuánto dura, etc.
var notSecretSuffixes = []string{
	"name", "names", "url", "uri", "endpoint", "path", "file", "header", "type", "issuer", "audience",
	"lifetime", "expiration", "expiry", "expires", "expiresin", "minutes", "seconds", "hours", "days",
	"timeout", "length", "provider", "scheme", "format", "version", "enabled", "required", "location",
	"prefix", "claim", "policy", "mode", "algorithm", "size", "count", "store", "vault", "id", "ids",
}

func settingHit(keyPath []string, value string, line int) *hit {
	name := ""
	for i := len(keyPath) - 1; i >= 0; i-- {
		if _, err := strconv.Atoi(keyPath[i]); err != nil {
			name = keyPath[i]
			break
		}
	}
	flat := strings.NewReplacer("_", "", "-", "", ".", "", " ", "").Replace(strings.ToLower(name))
	key := strings.Join(keyPath, ":")
	v := strings.TrimSpace(value)
	lower := strings.ToLower(v)
	if placeholder(v) || lower == "true" || lower == "false" || strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return nil
	}
	if _, err := strconv.ParseFloat(v, 64); err == nil {
		return nil
	}
	if strings.HasSuffix(flat, "clientid") {
		return &hit{rule: "client-id", severity: sevWarning, title: "ClientId escrito en la configuración", key: key, fix: fixClientID(key), value: value, line: line}
	}
	sensitive := false
	for _, w := range secretWords {
		if strings.Contains(flat, w) {
			sensitive = true
			break
		}
	}
	if !sensitive {
		return nil
	}
	for _, s := range notSecretSuffixes {
		if strings.HasSuffix(flat, s) {
			return nil
		}
	}
	return &hit{rule: "sensitive-setting", severity: sevCritical, title: "Secreto escrito en " + name, key: key, fix: fixKey(key), value: value, line: line}
}

// ─── appsettings.json ───────────────────────────────────────────────────────

type jsonString struct {
	path  []string
	line  int
	value string
}

// jsonStrings recorre un JSON (con los comentarios que acepta .NET) y devuelve
// cada valor de texto con su ruta de claves y su línea. No valida: un archivo
// a medio escribir se revisa igual.
func jsonStrings(data []byte) []jsonString {
	type frame struct {
		obj     bool
		key     string
		idx     int
		wantKey bool
	}
	var stack []frame
	var out []jsonString
	line := 1
	keyPath := func() []string {
		p := make([]string, len(stack))
		for i, f := range stack {
			if f.obj {
				p[i] = f.key
			} else {
				p[i] = strconv.Itoa(f.idx)
			}
		}
		return p
	}
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case c == '\n':
			line++
		case c == '/' && i+1 < len(data) && data[i+1] == '/':
			for i+1 < len(data) && data[i+1] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(data) && data[i+1] == '*':
			i += 2
			for i+1 < len(data) && !(data[i] == '*' && data[i+1] == '/') {
				if data[i] == '\n' {
					line++
				}
				i++
			}
			i++
		case c == '{':
			stack = append(stack, frame{obj: true, wantKey: true})
		case c == '[':
			stack = append(stack, frame{})
		case c == '}' || c == ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case c == ',':
			if n := len(stack); n > 0 {
				if stack[n-1].obj {
					stack[n-1].wantKey = true
				} else {
					stack[n-1].idx++
				}
			}
		case c == '"':
			j := i + 1
			for j < len(data) && data[j] != '"' && data[j] != '\n' {
				if data[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(data) || data[j] != '"' {
				continue // string sin cerrar: se sigue con la línea que viene
			}
			var s string
			if json.Unmarshal(data[i:j+1], &s) != nil {
				s = string(data[i+1 : j])
			}
			if n := len(stack); n > 0 && stack[n-1].obj && stack[n-1].wantKey {
				stack[n-1].key = s
				stack[n-1].wantKey = false
			} else {
				out = append(out, jsonString{keyPath(), line, s})
			}
			i = j
		}
	}
	return out
}

func scanAppSettings(data []byte) []hit {
	var out []hit
	for _, s := range jsonStrings(data) {
		key := strings.Join(s.path, ":")
		if hits := connHits(s.value, key, s.line, false); hits != nil || connPairs(s.value) != nil {
			out = append(out, hits...)
			continue
		}
		if h := settingHit(s.path, s.value, s.line); h != nil {
			out = append(out, *h)
		}
	}
	return out
}

// ─── .cs ────────────────────────────────────────────────────────────────────

// csStrings saca los literales de texto de una línea de C#: "…", @"…", $"…",
// y los """…""" que abren y cierran en la misma línea. Deja el contenido tal
// cual está escrito, sin interpretar escapes, así coincide con la línea.
func csStrings(line string) []string {
	var out []string
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '/' && i+1 < len(line) && line[i+1] == '/' {
			break
		}
		if c == '\'' { // un char: '"' no abre un string
			if j := strings.IndexByte(line[i+1:], '\''); j >= 0 && j <= 3 {
				i += j + 1
			}
			continue
		}
		if c != '"' {
			continue
		}
		if strings.HasPrefix(line[i:], `"""`) {
			if j := strings.Index(line[i+3:], `"""`); j >= 0 {
				out = append(out, line[i+3:i+3+j])
				i += 3 + j + 2
				continue
			}
		}
		verbatim := i > 0 && (line[i-1] == '@' || i > 1 && line[i-2] == '@' && line[i-1] == '$')
		j := i + 1
		for j < len(line) {
			if !verbatim && line[j] == '\\' {
				j += 2
				continue
			}
			if line[j] == '"' {
				if verbatim && j+1 < len(line) && line[j+1] == '"' {
					j += 2
					continue
				}
				break
			}
			j++
		}
		if j > len(line) {
			j = len(line)
		}
		out = append(out, line[i+1:j])
		i = j
	}
	return out
}

var builderPassword = regexp.MustCompile(`\bPassword\s*=\s*@?"([^"]*)"`)

func scanCS(data []byte) []hit {
	var out []hit
	usesBuilder := bytes.Contains(data, []byte("SqlConnectionStringBuilder"))
	for n, line := range strings.Split(string(data), "\n") {
		if strings.Contains(line, ignoreMark) {
			continue
		}
		num := n + 1
		warned := false
		for _, lit := range csStrings(line) {
			for _, h := range connHits(lit, "", num, true) {
				if h.rule == "cs-connection-string" {
					if warned {
						continue
					}
					warned = true
				}
				out = append(out, h)
			}
		}
		if usesBuilder {
			if m := builderPassword.FindStringSubmatch(line); m != nil && !placeholder(m[1]) {
				out = append(out, hit{rule: "cs-sql-password", severity: sevCritical, title: "Contraseña de SQL Server en SqlConnectionStringBuilder", fix: fixCS, value: m[1], line: num})
			}
		}
	}
	return out
}

// ─── otros archivos de texto ────────────────────────────────────────────────

var azureKeyRe = regexp.MustCompile(`(?i)\b(AccountKey|SharedAccessKey)\s*=\s*([^;"'\s<>]+)`)

func scanText(data []byte) []hit {
	var out []hit
	for n, line := range strings.Split(string(data), "\n") {
		if strings.Contains(line, ignoreMark) {
			continue
		}
		for _, m := range azureKeyRe.FindAllStringSubmatch(line, -1) {
			v := m[2]
			if placeholder(v) || v == azuriteKey {
				continue
			}
			if strings.EqualFold(m[1], "AccountKey") {
				out = append(out, hit{rule: "azure-account-key", severity: sevCritical, title: "Clave de Azure Storage (AccountKey)", fix: fixStorage, value: v, line: n + 1})
			} else {
				out = append(out, hit{rule: "azure-shared-access-key", severity: sevCritical, title: "Clave de Service Bus / Event Hubs (SharedAccessKey)", fix: fixServiceBus, value: v, line: n + 1})
			}
		}
	}
	return out
}

// ─── armado de hallazgos ────────────────────────────────────────────────────

// redact deja un prefijo corto y asteriscos. La cantidad de asteriscos es fija:
// tampoco se revela el largo.
func redact(v string) string {
	r := []rune(v)
	n := 0
	switch {
	case len(r) >= 16:
		n = 4
	case len(r) >= 8:
		n = 2
	case len(r) >= 4:
		n = 1
	}
	return string(r[:n]) + "****"
}

func findingID(file string, line int, rule string) string {
	sum := sha256.Sum256([]byte(file + ":" + strconv.Itoa(line) + ":" + rule))
	return hex.EncodeToString(sum[:6])
}

// scanFile revisa un archivo y devuelve sus hallazgos, con las líneas tapadas.
func scanFile(rel string, data []byte) []Finding {
	if len(data) > maxScanSize || bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
		return nil
	}
	rel = filepath.ToSlash(rel)
	var hits []hit
	switch {
	case isAppSettings(rel):
		hits = scanAppSettings(data)
	case strings.EqualFold(path.Ext(rel), ".cs"):
		hits = scanCS(data)
	case wantsScan(rel):
		hits = scanText(data)
	}
	if len(hits) == 0 {
		return nil
	}
	lines := strings.Split(string(data), "\n")

	// Todos los valores marcados de cada línea, para taparlos juntos.
	secrets := map[int][]string{}
	for _, h := range hits {
		secrets[h.line] = append(secrets[h.line], h.value)
	}
	seen := map[string]bool{}
	var out []Finding
	for _, h := range hits {
		if h.line < 1 || h.line > len(lines) || strings.Contains(lines[h.line-1], ignoreMark) {
			continue
		}
		f := Finding{
			ID: findingID(rel, h.line, h.rule), Rule: h.rule, Severity: h.severity, File: rel, Line: h.line,
			Title: h.title, Key: h.key, Redacted: redact(h.value), Fix: h.fix,
			Snippet: maskLine(lines[h.line-1], secrets[h.line]), secret: h.value,
		}
		if seen[f.ID+h.value] {
			continue
		}
		seen[f.ID+h.value] = true
		out = append(out, f)
	}
	return out
}

// maskLine tapa en la línea cada secreto, tal cual o como quedaría escapado en
// JSON. Si alguno no aparece en ninguna de las dos formas, no se muestra nada
// de la línea: mejor sin contexto que con el secreto a la vista.
func maskLine(line string, secrets []string) string {
	line = strings.TrimSpace(line)
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	for _, s := range secrets {
		if s == "" {
			continue
		}
		esc, _ := json.Marshal(s)
		escaped := strings.Trim(string(esc), `"`)
		if !strings.Contains(line, s) && !strings.Contains(line, escaped) {
			return "(línea oculta: el secreto está escrito de una forma que no puedo tapar)"
		}
		line = strings.ReplaceAll(line, s, redact(s))
		line = strings.ReplaceAll(line, escaped, redact(s))
	}
	if r := []rune(line); len(r) > 200 {
		line = string(r[:200]) + "…"
	}
	return line
}

func hasCritical(fs []Finding) bool {
	for _, f := range fs {
		if f.Severity == sevCritical {
			return true
		}
	}
	return false
}

func countSeverity(fs []Finding, sev string) int {
	n := 0
	for _, f := range fs {
		if f.Severity == sev {
			n++
		}
	}
	return n
}

// ─── qué se va a subir ──────────────────────────────────────────────────────

// pushCandidates lista los archivos que el próximo "Subir" puede mandar: los
// cambios contra lo que ya está en el remoto y los archivos nuevos, sin los que
// ignora .gitignore. Si la carpeta todavía no es un repo, usa un repo temporal
// solo para leer los .gitignore.
func pushCandidates(dir string) ([]string, error) {
	lines := func(out string) []string {
		var r []string
		for _, l := range strings.Split(out, "\x00") {
			if l != "" {
				r = append(r, l)
			}
		}
		return r
	}
	root, err := toplevel(dir)
	if err != nil || !samePath(root, dir) {
		tmp, err := os.MkdirTemp("", "apus-guard-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(tmp)
		if _, err := git(tmp, "init", "-q", "--bare"); err != nil {
			return nil, err
		}
		out, err := git(dir, "--git-dir="+tmp, "--work-tree="+dir, "ls-files", "-z", "-o", "--exclude-standard")
		return lines(out), err
	}

	var files []string
	if gitOK(dir, "rev-parse", "--verify", "--quiet", "@{upstream}") {
		out, err := git(dir, "diff", "-z", "--name-only", "--diff-filter=d", "@{upstream}")
		if err != nil {
			return nil, err
		}
		files = lines(out)
		out, err = git(dir, "ls-files", "-z", "-o", "--exclude-standard")
		if err != nil {
			return nil, err
		}
		files = append(files, lines(out)...)
	} else {
		out, err := git(dir, "ls-files", "-z", "-c", "-o", "--exclude-standard")
		if err != nil {
			return nil, err
		}
		files = lines(out)
	}
	sort.Strings(files)
	uniq := files[:0]
	for i, f := range files {
		if i == 0 || f != files[i-1] {
			uniq = append(uniq, f)
		}
	}
	return uniq, nil
}

// Guard revisa lo que se va a subir desde dir.
func Guard(dir string) ([]Finding, error) {
	fs, _, err := guardScan(dir)
	return fs, err
}

// guardScan revisa y además dice qué archivos miró.
func guardScan(dir string) ([]Finding, []string, error) {
	files, err := pushCandidates(dir)
	if err != nil {
		return nil, nil, err
	}
	var out []Finding
	var scanned []string
	for _, f := range files {
		if !wantsScan(f) {
			continue
		}
		full := filepath.Join(dir, filepath.FromSlash(f))
		st, err := os.Stat(full)
		if err != nil || !st.Mode().IsRegular() || st.Size() > maxScanSize {
			continue
		}
		data, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		scanned = append(scanned, filepath.ToSlash(f))
		out = append(out, scanFile(f, data)...)
	}
	sortFindings(out)
	return out, scanned, nil
}

// GuardLocal es la revisión de la máquina del usuario: revisa, anota en el log
// y saca lo que se marcó como ignorado en Aerodramus. Si el log no se puede
// usar, devuelve todo lo encontrado: mejor de más que de menos.
func GuardLocal(dir, remote string) (fs []Finding, ignored int, err error) {
	found, scanned, err := guardScan(dir)
	if err != nil {
		return nil, 0, err
	}
	repo, aerr := filepath.Abs(dir)
	if aerr != nil {
		repo = dir
	}
	kept, ignored, lerr := recordScan(filepath.Clean(repo), remote, found, scanned)
	if lerr != nil {
		return found, 0, nil
	}
	return kept, ignored, nil
}

func sortFindings(fs []Finding) {
	sort.SliceStable(fs, func(i, j int) bool {
		if fs[i].Severity != fs[j].Severity {
			return fs[i].Severity == sevCritical
		}
		if fs[i].File != fs[j].File {
			return fs[i].File < fs[j].File
		}
		return fs[i].Line < fs[j].Line
	})
}

// addedLines lee un diff con --unified=0 y devuelve, por archivo, las líneas
// que agrega (numeradas en la versión nueva).
func addedLines(diff string) map[string]map[int]bool {
	out := map[string]map[int]bool{}
	var file string
	hunk := regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@`)
	for _, l := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(l, "+++ "):
			file = strings.TrimPrefix(strings.TrimPrefix(l, "+++ "), "b/")
			if file == "/dev/null" {
				file = ""
			}
		case strings.HasPrefix(l, "@@") && file != "":
			m := hunk.FindStringSubmatch(l)
			if m == nil {
				continue
			}
			start, _ := strconv.Atoi(m[1])
			count := 1
			if m[2] != "" {
				count, _ = strconv.Atoi(m[2])
			}
			if out[file] == nil {
				out[file] = map[int]bool{}
			}
			for i := 0; i < count; i++ {
				out[file][start+i] = true
			}
		}
	}
	return out
}

// GuardDiff revisa lo que agrega un rango de commits (un PR): los archivos
// como quedan en head, y solo los hallazgos en líneas agregadas.
func GuardDiff(dir, base, head string) ([]Finding, error) {
	cmd := exec.Command("git", "-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=d", base+"..."+head)
	cmd.Dir = dir
	noConsole(cmd)
	diff, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var out []Finding
	for file, added := range addedLines(string(diff)) {
		if !wantsScan(file) {
			continue
		}
		data, err := exec.Command("git", "-C", dir, "show", head+":"+file).Output()
		if err != nil {
			continue
		}
		for _, f := range scanFile(file, data) {
			if added[f.Line] {
				out = append(out, f)
			}
		}
	}
	sortFindings(out)
	return out, nil
}
