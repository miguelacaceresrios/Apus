package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Las claves de prueba se arman en partes: así este archivo no dispara
// escáneres de secretos (el de GitHub incluido) y queda claro que son falsas.
var (
	fakeStorageKey = "q7Wd" + strings.Repeat("Zk3P", 20) + "Lm9x=="
	fakeSASKey     = "Hx2s" + strings.Repeat("Qv8R", 9) + "Tn1="
)

// noLeak revisa que ningún campo que se muestra o se manda tenga el secreto.
func noLeak(t *testing.T, fs []Finding, secrets ...string) {
	t.Helper()
	data, err := json.Marshal(fs)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range secrets {
		if strings.Contains(string(data), s) {
			t.Fatalf("el secreto %q se filtró en la salida:\n%s", redact(s), data)
		}
	}
}

func TestGuardAppSettings(t *testing.T) {
	data := `{
  // comentario de .NET
  "ConnectionStrings": {
    "Default": "Server=tcp:db.example.net,1433;Initial Catalog=app;User ID=admin;Password=Sup3r-S3creta!;Encrypt=True",
    "Local": "Server=(localdb)\\MSSQLLocalDB;Database=app;Trusted_Connection=True",
    "Storage": "DefaultEndpointsProtocol=https;AccountName=miapp;AccountKey=` + fakeStorageKey + `;EndpointSuffix=core.windows.net",
    "Bus": "Endpoint=sb://miapp.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=` + fakeSASKey + `",
    "SoloUsuario": "Server=db;Database=app;User ID=deploy;Password=CHANGE_ME"
  },
  "SendGrid": { "ApiKey": "SG.abcdefghijklmnop.qrstuvwxyz0123456789" },
  "AzureAd": {
    "ClientId": "8f2c1d9e-1111-2222-3333-444455556666",
    "ClientSecret": "7Qx~abcDEF123ghiJKL456mno",
    "TokenLifetimeMinutes": "60",
    "ClientSecretName": "api-client-secret"
  },
  "Jwt": { "Secret": "" , "Issuer": "https://login.example.net" },
  "Stripe": { "SecretKey": "${STRIPE_SECRET}" },
  "Twilio": { "AuthToken": "@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/twilio)" }
}`
	fs := scanFile("src/Api/appsettings.Production.json", []byte(data))
	got := map[string]int{}
	for _, f := range fs {
		got[f.Rule+"@"+f.Key]++
	}
	want := []string{
		"sql-password@ConnectionStrings:Default",
		"azure-account-key@ConnectionStrings:Storage",
		"azure-shared-access-key@ConnectionStrings:Bus",
		"sql-user@ConnectionStrings:SoloUsuario",
		"sensitive-setting@SendGrid:ApiKey",
		"client-id@AzureAd:ClientId",
		"sensitive-setting@AzureAd:ClientSecret",
	}
	for _, w := range want {
		if got[w] != 1 {
			t.Errorf("faltó %s (encontré %v)", w, got)
		}
	}
	if len(fs) != len(want) {
		t.Errorf("esperaba %d hallazgos, hubo %d: %v", len(want), len(fs), got)
	}

	for _, f := range fs {
		if f.File != "src/Api/appsettings.Production.json" || f.Line < 1 || f.Fix == "" || f.ID == "" {
			t.Errorf("hallazgo incompleto: %+v", f)
		}
		if !strings.HasSuffix(f.Redacted, "****") {
			t.Errorf("valor sin tapar: %q", f.Redacted)
		}
		wantSev := sevCritical
		if f.Rule == "sql-user" || f.Rule == "client-id" {
			wantSev = sevWarning
		}
		if f.Severity != wantSev {
			t.Errorf("%s: severidad %s, esperaba %s", f.Rule, f.Severity, wantSev)
		}
	}
	// La línea 4 es la del connection string de SQL.
	for _, f := range fs {
		if f.Rule == "sql-password" {
			if f.Line != 4 {
				t.Errorf("sql-password en la línea %d, está en la 4", f.Line)
			}
			if !strings.Contains(f.Fix, `dotnet user-secrets set "ConnectionStrings:Default"`) || !strings.Contains(f.Fix, "ConnectionStrings__Default") {
				t.Errorf("el arreglo no es concreto: %s", f.Fix)
			}
		}
	}
	noLeak(t, fs, "Sup3r-S3creta!", fakeStorageKey, fakeSASKey, "SG.abcdefghijklmnop.qrstuvwxyz0123456789", "7Qx~abcDEF123ghiJKL456mno")
}

func TestGuardPlaceholders(t *testing.T) {
	for _, v := range []string{
		"", "   ", "CHANGE_ME", "changeme", "<password>", "{password}", "${DB_PASSWORD}", "$(DbPassword)",
		"%DB_PASS%", "#{DbPassword}#", "__DbPassword__", "xxxxxxxx", "********", "your-api-key",
		"YourStrong@Passw0rd", "REPLACE_WITH_REAL_KEY", "TODO", "@Microsoft.KeyVault(SecretUri=x)", "placeholder",
	} {
		if !placeholder(v) {
			t.Errorf("%q es de relleno", v)
		}
	}
	for _, v := range []string{"Sup3r-S3creta!", fakeStorageKey, "hunter2", "P@ssw0rd2024", "q7WdtbdZk3xxxP"} {
		if placeholder(v) {
			t.Errorf("%q es un secreto de verdad", v)
		}
	}
}

func TestGuardCSharp(t *testing.T) {
	data := `using Microsoft.Data.SqlClient;

class Db {
    const string Cs = "Server=tcp:db.example.net;Database=app;User ID=admin;Password=Pr0d-Pass!;";
    const string Local = "Server=(localdb)\\MSSQLLocalDB;Database=app;Integrated Security=true";
    string Armado(string pwd) => $"Server=db;Database=app;User ID=app;Password={pwd}";
    string Partes = "Server=tcp:x.database.windows.net;" +
        "Database=db;User ID=admin;Password=Otra-Clave9;";
    void B() { var b = new SqlConnectionStringBuilder { DataSource = "db", Password = "Build3r-Pass" }; }
    // "Server=db;Password=EnComentario1" no cuenta
    const string Ok = "Server=db;Password=Ignorada1;"; // apus-guard:ignore
    char c = '"'; string s = "Server=db;Database=x;Password=Tras-Char1";
}
`
	fs := scanFile("src/Data/Db.cs", []byte(data))
	byLine := map[int][]string{}
	for _, f := range fs {
		byLine[f.Line] = append(byLine[f.Line], f.Rule+":"+f.Severity)
	}
	want := map[int]string{
		4:  "cs-sql-password:critical",
		6:  "cs-connection-string:warning",
		8:  "cs-sql-password:critical",
		9:  "cs-sql-password:critical",
		12: "cs-sql-password:critical",
	}
	for line, w := range want {
		if len(byLine[line]) != 1 || byLine[line][0] != w {
			t.Errorf("línea %d: esperaba %s, hubo %v", line, w, byLine[line])
		}
	}
	for _, line := range []int{5, 7, 10, 11} {
		if len(byLine[line]) > 0 {
			t.Errorf("línea %d no tenía que marcar nada: %v", line, byLine[line])
		}
	}
	noLeak(t, fs, "Pr0d-Pass!", "Otra-Clave9", "Build3r-Pass", "Tras-Char1")
}

func TestGuardOtherFiles(t *testing.T) {
	yml := "env:\n  STORAGE: DefaultEndpointsProtocol=https;AccountName=x;AccountKey=" + fakeStorageKey + "\n  DEV: UseDevelopmentStorage=true;AccountKey=" + azuriteKey + "\n"
	fs := scanFile("deploy/pipeline.yml", []byte(yml))
	if len(fs) != 1 || fs[0].Rule != "azure-account-key" || fs[0].Line != 2 {
		t.Fatalf("esperaba una AccountKey en la línea 2 (la de Azurite es pública): %+v", fs)
	}
	noLeak(t, fs, fakeStorageKey)

	// Un README o un binario no se revisan.
	if fs := scanFile("docs/README.md", []byte("AccountKey="+fakeStorageKey)); fs != nil {
		t.Errorf("un .md no se revisa: %+v", fs)
	}
	if fs := scanFile("x.json", []byte("AccountKey="+fakeStorageKey+"\x00")); fs != nil {
		t.Errorf("un binario no se revisa: %+v", fs)
	}
}

// La línea que se muestra tapa todos los secretos que tiene, no solo el del hallazgo.
func TestGuardSnippetTapaTodo(t *testing.T) {
	line := `"X": "Endpoint=sb://a.servicebus.windows.net/;SharedAccessKey=` + fakeSASKey + `;AccountName=b;AccountKey=` + fakeStorageKey + `"`
	fs := scanText([]byte(line))
	if len(fs) != 2 {
		t.Fatalf("esperaba dos claves: %+v", fs)
	}
	for _, f := range scanFile("x.config", []byte(line)) {
		if strings.Contains(f.Snippet, fakeSASKey) || strings.Contains(f.Snippet, fakeStorageKey) {
			t.Fatalf("la línea mostrada deja ver un secreto: %s", f.Snippet)
		}
	}
}

func TestRedact(t *testing.T) {
	for in, want := range map[string]string{
		"abc":                  "****",
		"abcdefg":              "a****",
		"abcdefghij":           "ab****",
		"abcdefghijklmnopqrst": "abcd****",
	} {
		if got := redact(in); got != want {
			t.Errorf("redact(%q) = %q, esperaba %q", in, got, want)
		}
	}
}

func TestAddedLines(t *testing.T) {
	diff := `diff --git a/appsettings.json b/appsettings.json
--- a/appsettings.json
+++ b/appsettings.json
@@ -3,0 +4,2 @@
+  "a": 1,
+  "b": 2
@@ -10 +12 @@
-x
+y
diff --git a/borrado.cs b/borrado.cs
--- a/borrado.cs
+++ /dev/null
@@ -1 +0,0 @@
-z
`
	got := addedLines(diff)
	for _, l := range []int{4, 5, 12} {
		if !got["appsettings.json"][l] {
			t.Errorf("la línea %d es nueva", l)
		}
	}
	if got["appsettings.json"][6] || len(got) != 1 {
		t.Errorf("de más: %v", got)
	}
}

// Guard mira lo que se va a subir: respeta .gitignore, y en un repo con
// remoto solo lo que cambió.
func TestGuardRepo(t *testing.T) {
	tmp := entorno(t)
	dir := carpeta(t, tmp, "api")
	write := func(name, content string) {
		t.Helper()
		p := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	secret := `{"ConnectionStrings":{"Db":"Server=db;Database=x;User ID=sa;Password=Muy-Secreta1"}}`
	write("appsettings.json", `{"Logging":{}}`)
	write("appsettings.Development.json", secret)
	write(".gitignore", "appsettings.Development.json\n")

	// Carpeta que todavía no es repo: el ignorado no cuenta.
	fs, err := Guard(dir)
	if err != nil || len(fs) != 0 {
		t.Fatalf("el archivo ignorado no se sube, no cuenta: %v %+v", err, fs)
	}

	write("src/appsettings.json", secret)
	fs, err = Guard(dir)
	if err != nil || len(fs) != 1 || fs[0].File != "src/appsettings.json" || !hasCritical(fs) {
		t.Fatalf("esperaba el secreto de src/appsettings.json: %v %+v", err, fs)
	}

	// Ya subido: lo que no cambió no se vuelve a marcar.
	os.Remove(filepath.Join(dir, "src", "appsettings.json"))
	remoto := bare(t, tmp, "remoto.git")
	if _, err := Send(dir, remoto); err != nil {
		t.Fatal(err)
	}
	write("Program.cs", `var cs = "Server=db;Database=x;Password=Otra-Mas2";`)
	fs, err = Guard(dir)
	if err != nil || len(fs) != 1 || fs[0].File != "Program.cs" {
		t.Fatalf("esperaba solo Program.cs: %v %+v", err, fs)
	}
}
