#!/usr/bin/env bash
#
# Batería de pruebas de apus. Arma repos de juguete en un directorio temporal
# (con un bare local haciendo de "GitHub") y verifica los códigos de salida.
#
#   scripts/test.sh                 # prueba apus.sh
#   APUS_IMPL=go scripts/test.sh    # prueba el binario de dist/
#
# No toca tu configuración de git: usa GIT_CONFIG_GLOBAL apuntando al temporal.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

# Qué implementación probar: bash (apus.sh) o go (el binario compilado).
IMPL="${APUS_IMPL:-bash}"
case "$IMPL" in
	bash)
		APUS="$HERE/apus.sh"
		[[ -x "$APUS" ]] || { echo "no encuentro apus.sh ejecutable"; exit 1; }
		RUN=(bash "$APUS")
		RUNSTR="bash '$APUS'"
		;;
	go)
		APUS="$ROOT/dist/apus.exe"
		[[ -x "$APUS" ]] || APUS="$ROOT/dist/apus"
		[[ -x "$APUS" ]] || { echo "no encuentro dist/apus: compilá con 'make build' o 'scripts/build.ps1'"; exit 1; }
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

pass=0; fail=0

check() { # check "nombre" <exit esperado> comando...
	local name="$1" want="$2"; shift 2
	local out rc=0
	# stdin vacío: ningún caso puede quedarse esperando el teclado. Los que
	# necesitan responder algo lo mandan por su propio pipe.
	out="$("$@" 2>&1 </dev/null)" || rc=$?
	if [[ "$rc" == "$want" ]]; then
		pass=$(( pass + 1 )); printf 'ok    %-44s exit=%s\n' "$name" "$rc"
	else
		fail=$(( fail + 1 )); printf 'FALLA %-44s exit=%s (esperaba %s)\n%s\n' "$name" "$rc" "$want" "$out"
	fi
}

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

# ─── sin remoto: apus avisa y no toca nada ───────────────────────────────────

git init -q "$TMP/sinremoto"; cd "$TMP/sinremoto" || exit 1; echo x > x.txt
check "repo sin remoto: avisa"                1 "${RUN[@]}" -q
check "pero el commit quedó hecho"            0 bash -c '[[ -z "$(git status --porcelain)" ]]'
check "y sigue avisando si insistís"          1 "${RUN[@]}" -q

git remote add origin "$TMP/remote-nuevo.git"
git init -q --bare "$TMP/remote-nuevo.git"
check "con el remoto puesto, sube"            0 "${RUN[@]}" -q

# ─── carpeta que todavía no es repo ──────────────────────────────────────────

mkdir -p "$TMP/nueva"; cd "$TMP/nueva" || exit 1; echo y > y.txt
check "ofrece iniciar el repo (s)"            1 bash -c "printf 's\n' | $RUNSTR -q"
check "y lo inicializó"                       0 bash -c '[[ -d .git ]]'
check "con el commit adentro"                 0 bash -c 'git log -1 --oneline >/dev/null 2>&1'

mkdir -p "$TMP/nueva2"; cd "$TMP/nueva2" || exit 1; echo z > z.txt
check "si decís que no, no toca nada"         1 bash -c "printf 'n\n' | $RUNSTR -q"
check "y no quedó ningún .git"                0 bash -c '[[ ! -d .git ]]'

# ─── sin terminal: no pregunta nada ──────────────────────────────────────────

mkdir -p "$TMP/sinrepo"; cd "$TMP/sinrepo" || exit 1; echo v > v.txt
check "sin repo y sin terminal"               1 bash -c "$RUNSTR -q </dev/null"

# ─── resumen ─────────────────────────────────────────────────────────────────

printf '\n%s ok, %s fallas\n' "$pass" "$fail"
(( fail == 0 ))
