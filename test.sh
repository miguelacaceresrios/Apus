#!/usr/bin/env bash
#
# Batería de pruebas de apus. Arma repos de juguete en un directorio temporal
# (con un bare local haciendo de "GitHub") y verifica los códigos de salida.
#
#   ./test.sh
#
# No toca tu configuración de git: usa GIT_CONFIG_GLOBAL apuntando al temporal.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Qué implementación probar: bash (apus.sh) o go (el binario compilado).
IMPL="${APUS_IMPL:-bash}"
case "$IMPL" in
	bash)
		APUS="$ROOT/apus.sh"
		[[ -x "$APUS" ]] || { echo "no encuentro apus.sh ejecutable"; exit 1; }
		RUN=(bash "$APUS")
		RUNSTR="bash '$APUS'"
		;;
	go)
		APUS="$ROOT/apus.exe"
		[[ -x "$APUS" ]] || APUS="$ROOT/apus"
		[[ -x "$APUS" ]] || { echo "no encuentro el binario: corré 'go build -o apus .'"; exit 1; }
		RUN=("$APUS")
		RUNSTR="'$APUS'"
		;;
	*) echo "APUS_IMPL tiene que ser 'bash' o 'go'"; exit 1 ;;
esac
echo "probando la implementación: $IMPL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL="$TMP/gitconfig"
git config --global user.name  "apus test"
git config --global user.email "test@example.com"
git config --global init.defaultBranch main

# El binario Go es nativo de Windows y no entiende rutas MSYS (/tmp/...), así que
# cuando lo probamos le pasamos las rutas en la forma que él sí entiende.
native() {
	if [[ "$IMPL" == go ]] && command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	else
		printf '%s' "$1"
	fi
}

pass=0; fail=0

check() { # check "nombre" <exit esperado> comando...
	local name="$1" want="$2"; shift 2
	local out rc=0
	out="$("$@" 2>&1)" || rc=$?
	if [[ "$rc" == "$want" ]]; then
		pass=$(( pass + 1 )); printf 'ok    %-44s exit=%s\n' "$name" "$rc"
	else
		fail=$(( fail + 1 )); printf 'FALLA %-44s exit=%s (esperaba %s)\n%s\n' "$name" "$rc" "$want" "$out"
	fi
}

# ─── gh falso ────────────────────────────────────────────────────────────────
# Devuelve tres repos; uno apunta al bare local para poder pushear de verdad.
# apus.sh pide TSV (con --jq) y el binario pide JSON: servimos los dos.

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<GH
#!/usr/bin/env bash
case "\$1" in
	auth)   exit 0 ;;
	config) printf 'https\n'; exit 0 ;;
	api)    printf 'gato\n'; exit 0 ;;
	repo)
		case "\$2" in
			create) printf 'Created repository gato/%s on GitHub\n' "\$3"; exit 0 ;;
			list)
				if [[ " \$* " == *" --jq "* ]]; then
					printf '%s\t%s\t%s\t%s\t%s\n' \
					  "gato/uno"  "PRIVATE" "https://github.com/gato/uno"  "git@github.com:gato/uno.git"  "2026-09-01T10:00:00Z" \
					  "gato/link" "PUBLIC"  "$TMP/remote-link.git"         "$TMP/remote-link.git"         "2026-09-10T08:00:00Z" \
					  "gato/tres" "PRIVATE" "https://github.com/gato/tres" "git@github.com:gato/tres.git" "2026-08-02T08:00:00Z"
				else
					cat <<'JSON'
[
 {"nameWithOwner":"gato/uno","visibility":"PRIVATE","url":"https://github.com/gato/uno","sshUrl":"git@github.com:gato/uno.git","updatedAt":"2026-09-01T10:00:00Z"},
 {"nameWithOwner":"gato/link","visibility":"PUBLIC","url":"__LINK__","sshUrl":"__LINK__","updatedAt":"2026-09-10T08:00:00Z"},
 {"nameWithOwner":"gato/tres","visibility":"PRIVATE","url":"https://github.com/gato/tres","sshUrl":"git@github.com:gato/tres.git","updatedAt":"2026-08-02T08:00:00Z"}
]
JSON
				fi
				exit 0 ;;
		esac ;;
esac
exit 1
GH
# la ruta del bare local se inyecta acá para no pelear con las comillas del heredoc
sed -i "s|__LINK__|$TMP/remote-link.git|g" "$TMP/bin/gh"
chmod +x "$TMP/bin/gh"

# En Windows sólo se puede ejecutar algo con extensión conocida, así que el
# binario necesita este puente para llegar al stub. En Linux sobra y no molesta.
printf '@echo off\r\nbash "%%~dp0gh" %%*\r\n' > "$TMP/bin/gh.cmd"

# ─── flujo básico: add + commit + push ───────────────────────────────────────

git init -q --bare "$TMP/remote.git"
git init -q "$TMP/r"; cd "$TMP/r" || exit 1
git remote add origin "$TMP/remote.git"
echo uno > a.txt

check "primer push (crea upstream)"           0 "${RUN[@]}" -q "init"
check "nada que hacer"                        0 "${RUN[@]}" -q
echo dos >> a.txt
check "mensaje propio"                        0 "${RUN[@]}" -q "fix: bug"
echo tres >> a.txt
check "dry-run no ejecuta nada"               0 "${RUN[@]}" -q -n
check "y deja el árbol sucio"                 0 bash -c '[[ -n "$(git status --porcelain)" ]]'
check "commit + push"                         0 "${RUN[@]}" -q

git remote set-url origin "$TMP/no-existe.git"; echo cuatro >> a.txt
check "push fallido"                          3 "${RUN[@]}" -q
git remote set-url origin "$TMP/remote.git"
check "reintento sube el commit pendiente"    0 "${RUN[@]}" -q

git checkout -q --detach HEAD
check "HEAD desprendido"                      1 "${RUN[@]}" -q
git checkout -q main

printf '#!/bin/sh\nexit 1\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit
echo cinco >> a.txt
check "hook rechaza el commit"                1 "${RUN[@]}" -q "no entra"
rm .git/hooks/pre-commit
check "después del hook, sube igual"          0 "${RUN[@]}" -q "ahora si"

echo "*.log" > .gitignore; "${RUN[@]}" -q "chore: ignore" >/dev/null 2>&1
echo ruido > debug.log
check "sólo archivos ignorados: no-op"        0 "${RUN[@]}" -q

# ─── argumentos ──────────────────────────────────────────────────────────────

check "opción desconocida"                    2 "${RUN[@]}" --nope
check "demasiados argumentos"                 2 "${RUN[@]}" uno dos
check "mensaje duplicado"                     2 "${RUN[@]}" -m a b
check "-m sin valor"                          2 "${RUN[@]}" -m
check "--help"                                0 "${RUN[@]}" --help
check "--version"                             0 "${RUN[@]}" -V

# ─── elección de remoto ──────────────────────────────────────────────────────

git remote rename origin up; git remote add otro "$TMP/remote.git"
git checkout -q -b otra-rama; echo seis > f.txt
check "varios remotos sin origin"             1 "${RUN[@]}" -q
check "APUS_REMOTE inexistente"               1 env APUS_REMOTE=nope "${RUN[@]}" -q
check "APUS_REMOTE válido"                    0 env APUS_REMOTE=otro "${RUN[@]}" -q

# ─── vinculación (gh falso, respuestas por pipe) ─────────────────────────────

export PATH="$TMP/bin:$PATH"
git init -q --bare "$TMP/remote-link.git"

mkdir -p "$TMP/link"; cd "$TMP/link" || exit 1; echo x > x.txt
check "init + elegir repo de la lista"        0 bash -c "printf 's\n2\n' | $RUNSTR -q 'primer vuelo'"
check "quedó vinculado a origin"              0 bash -c '[[ -n "$(git remote get-url origin)" ]]'

git init -q --bare "$TMP/remote-u.git"
git init -q "$TMP/pega"; cd "$TMP/pega" || exit 1; echo y > y.txt
check "pegar una ruta/URL (opción u)"         0 bash -c "printf 'u\n$(native "$TMP/remote-u.git")\n' | $RUNSTR -q"
git init -q --bare "$TMP/remote-relink.git"
check "--link cambia el remoto"               0 bash -c "printf 'u\n$(native "$TMP/remote-relink.git")\n' | $RUNSTR -q --link"

git init -q "$TMP/crear"; cd "$TMP/crear" || exit 1; echo z > z.txt
check "crear repo nuevo (opción n, dry-run)"  0 bash -c "printf 'n\nflamante\npublic\n' | $RUNSTR -q -n"
check "usuario/repo abreviado (dry-run)"      0 bash -c "printf 'u\ngato/algo\n' | $RUNSTR -q -n"
check "cancelar la vinculación"               1 bash -c "printf 'q\n' | $RUNSTR -q"
check "entrada inválida y después cancelar"   1 bash -c "printf 'pepe\n/tres\n99\nq\n' | $RUNSTR -q"

# ─── sin terminal: no pregunta nada ──────────────────────────────────────────

git init -q "$TMP/muda"; cd "$TMP/muda" || exit 1; echo w > w.txt
check "sin remoto y sin terminal"             1 bash -c "$RUNSTR -q </dev/null"
mkdir -p "$TMP/sinrepo"; cd "$TMP/sinrepo" || exit 1; echo v > v.txt
check "sin repo y sin terminal"               1 bash -c "$RUNSTR -q </dev/null"

# ─── resumen ─────────────────────────────────────────────────────────────────

printf '\n%s ok, %s fallas\n' "$pass" "$fail"
(( fail == 0 ))
