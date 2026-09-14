#!/usr/bin/env bash
#
# apus — un solo comando para forjar y enviar tus cambios.
#
#   apus                      commit con mensaje autogenerado (fecha/hora)
#   apus "fix: arreglo bug X" commit con mensaje propio
#
# Encadena add + commit + push. Si la carpeta no es un repo, ofrece iniciarlo.
# El remoto lo configurás vos con git; apus sólo publica la rama la primera vez.
# Evita commits vacíos y devuelve un código de salida distinto de 0 si el push falla.

set -euo pipefail

APUS_VERSION="2.1.0"

# ─── salida ──────────────────────────────────────────────────────────────────

if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
	C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
	C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
else
	C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''
fi

QUIET=0
DRY_RUN=0

step() { (( QUIET )) || printf '%s\n' "${C_DIM}» $*${C_RESET}" >&2; }
ok()   { (( QUIET )) || printf '%s\n' "${C_GREEN}✔${C_RESET} $*" >&2; }
note() { (( QUIET )) || printf '%s\n' "${C_DIM}  $*${C_RESET}" >&2; }
warn() { printf '%s\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
die()  { printf '%s\n' "${C_RED}✖${C_RESET} $1" >&2; exit "${2:-1}"; }

# Arma una línea de comando legible, entrecomillando sólo lo que hace falta.
cmdline() {
	local out='' arg
	for arg in "$@"; do
		if [[ "$arg" =~ ^[A-Za-z0-9_./=:@{}-]+$ ]]; then
			out+="$arg "
		else
			out+="'${arg//\'/\'\\\'\'}' "
		fi
	done
	printf '%s' "${out% }"
}

# Ejecuta un comando mostrándolo antes; en --dry-run sólo lo muestra.
run() {
	step "$(cmdline "$@")"
	(( DRY_RUN )) && return 0
	"$@"
}

# ─── preguntas ───────────────────────────────────────────────────────────────

# ¿Hay con quién hablar? Una terminal, o alguien mandando respuestas por un pipe
# (scripts, pruebas). Con la entrada vacía (cron, hooks) no preguntamos. Es el
# mismo criterio que el binario.
can_prompt() {
	[[ -t 0 || -p /dev/stdin ]]
}

# Las respuestas se leen de stdin. No de /dev/tty: si llegan por un pipe, son esas
# y no el teclado.
prompt_read() {
	IFS= read -r "$1"
}

ask() { # ask VARIABLE "pregunta" ["default"]
	local __v="$1" q="$2" def="${3:-}" line=''
	if [[ -n "$def" ]]; then
		printf '%s' "${C_BOLD}?${C_RESET} $q ${C_DIM}[$def]${C_RESET}: " >&2
	else
		printf '%s' "${C_BOLD}?${C_RESET} $q: " >&2
	fi
	prompt_read line || { printf '\n' >&2; return 1; }
	[[ -n "$line" ]] || line="$def"
	printf -v "$__v" '%s' "$line"
}

confirm() { # confirm "pregunta" ["s"|"n"]
	local ans=''
	ask ans "$1 (s/n)" "${2:-s}" || return 1
	[[ "${ans,,}" == s* || "${ans,,}" == y* ]]
}

# URL navegable (https, sin .git) para mostrar al final; vacío si es una ruta local.
browse_url() {
	local u="$1" host path
	case "$u" in
		git@*:*)     host="${u#git@}"; host="${host%%:*}"; path="${u#*:}"; u="https://$host/$path" ;;
		ssh://git@*) u="https://${u#ssh://git@}" ;;
		http://*|https://*) ;;
		*) return 0 ;;
	esac
	printf '%s' "${u%.git}"
}

# Elige el remoto para publicar una rama sin upstream. Escribe en $REMOTE en vez
# de devolver por stdout: así die() puede cortar el script y no sólo un subshell.
REMOTE=''
resolve_remote() {
	local -a remotes=()
	local r
	while IFS= read -r r; do [[ -n "$r" ]] && remotes+=("$r"); done < <(git remote)

	if [[ -n "${APUS_REMOTE:-}" ]]; then
		git remote get-url "$APUS_REMOTE" >/dev/null 2>&1 \
			|| die "APUS_REMOTE apunta a '$APUS_REMOTE', que no es un remoto de este repo"
		REMOTE="$APUS_REMOTE"
	elif (( ${#remotes[@]} == 0 )); then
		die "este repo no tiene remoto: agregalo con 'git remote add origin <url>'"
	elif git remote get-url origin >/dev/null 2>&1; then
		REMOTE='origin'
	elif (( ${#remotes[@]} == 1 )); then
		REMOTE="${remotes[0]}"
	else
		die "hay varios remotos (${remotes[*]}) y ninguno se llama origin: elegí con APUS_REMOTE=<remoto>"
	fi
}

# Push con diagnóstico: si el remoto tiene commits que no tenés, lo dice.
do_push() {
	local out='' rc=0
	step "$(cmdline "$@")"
	(( DRY_RUN )) && return 0
	out="$("$@" 2>&1)" || rc=$?
	[[ -z "$out" ]] || printf '%s\n' "$out" >&2
	if (( rc )); then
		case "$out" in
			*"fetch first"*|*"non-fast-forward"*|*"[rejected]"*)
				warn "el remoto tiene commits que vos no tenés: corré 'git pull --rebase' y volvé a lanzar apus" ;;
			*"Authentication failed"*|*"Permission denied"*|*"could not read Username"*)
				warn "problema de credenciales: probá 'gh auth login' o configurá tu clave SSH" ;;
		esac
	fi
	return "$rc"
}

usage() {
	cat <<'USAGE'
apus — add + commit + push en un solo vuelo.

USO
  apus [opciones] [mensaje]

OPCIONES
  -m, --message <msg>   Mensaje de commit (igual que el argumento posicional).
  -n, --dry-run         Muestra los comandos sin ejecutar nada.
  -q, --quiet           Silencia la salida de apus (no la de git).
  -h, --help            Esta ayuda.
  -V, --version         Versión.

MENSAJE
  Sin mensaje, apus lo genera desde la plantilla por defecto:
      chore: actualización {date}

REMOTO
  apus no crea repos ni configura remotos: eso lo hacés vos, una vez, con
  'git remote add origin <url>'. Lo que sí hace solo es publicar la rama la
  primera vez, con 'git push -u'.

VARIABLES DE ENTORNO
  APUS_MESSAGE_TEMPLATE   plantilla del mensaje; {date} se reemplaza por la fecha.
  APUS_DATE_FORMAT        formato para date(1) (por defecto '%Y-%m-%d %H:%M').
  APUS_REMOTE             remoto a usar cuando la rama no tiene upstream.
  APUS_DEFAULT_BRANCH     rama inicial al hacer 'git init' (por defecto 'main').
  NO_COLOR                salida sin colores.

CÓDIGOS DE SALIDA
  0  todo bien (incluye "no había nada que hacer")
  1  error de repo (sin remoto, HEAD desprendido, commit rechazado por un hook)
  2  uso incorrecto
  3  el push falló
USAGE
}

# ─── argumentos ──────────────────────────────────────────────────────────────

MESSAGE=''
message_set=0

while (( $# )); do
	case "$1" in
		-m|--message)
			(( $# >= 2 )) || die "-m necesita un mensaje" 2
			MESSAGE="$2"; message_set=1; shift 2 ;;
		--message=*)
			MESSAGE="${1#*=}"; message_set=1; shift ;;
		-n|--dry-run) DRY_RUN=1; shift ;;
		-q|--quiet)   QUIET=1; shift ;;
		-h|--help)    usage; exit 0 ;;
		-V|--version) printf 'apus %s\n' "$APUS_VERSION"; exit 0 ;;
		--)           shift; break ;;
		-*)           die "opción desconocida: $1 (probá 'apus --help')" 2 ;;
		*)            break ;;
	esac
done

if (( $# )); then
	(( ! message_set )) || die "mensaje duplicado: usá -m o el argumento posicional, no ambos" 2
	MESSAGE="$1"; message_set=1; shift
	(( $# == 0 )) || die "demasiados argumentos: '$1' (¿le faltan comillas al mensaje?)" 2
fi

# ─── contexto del repo ───────────────────────────────────────────────────────

command -v git >/dev/null 2>&1 || die "git no está instalado o no está en el PATH"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	can_prompt || die "esto no es un repositorio git: $PWD"
	warn "esto no es un repositorio git: $PWD"
	confirm "¿lo inicializo acá?" s || die "listo, no toco nada"
	run git init -b "${APUS_DEFAULT_BRANCH:-main}" 2>/dev/null || run git init
	(( ! DRY_RUN )) || { ok "dry-run: todo lo demás depende de ese init"; exit 0; }
fi

[[ "$(git rev-parse --is-bare-repository)" == 'false' ]] \
	|| die "el repositorio es bare: no hay árbol de trabajo que subir"

cd "$(git rev-parse --show-toplevel)"

branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$branch" ]] \
	|| die "HEAD está desprendido (detached): hacé checkout de una rama antes de volar"

if git rev-parse --verify --quiet HEAD >/dev/null; then has_head=1; else has_head=0; fi
if [[ -n "$(git status --porcelain)" ]]; then dirty=1; else dirty=0; fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"

unpushed=0
if [[ -n "$upstream" ]] && (( has_head )); then
	unpushed="$(git rev-list --count "$upstream..HEAD" 2>/dev/null || printf '0')"
fi

# ─── nada que hacer ──────────────────────────────────────────────────────────

if (( ! dirty )); then
	if (( ! has_head )); then
		ok "repo vacío y sin cambios: nada que hacer"
		exit 0
	fi
	if [[ -n "$upstream" ]] && (( unpushed == 0 )); then
		ok "nada que hacer: árbol limpio y $branch al día con $upstream"
		exit 0
	fi
fi

# ─── add + commit ────────────────────────────────────────────────────────────

committed=0
if (( dirty )); then
	run git add -A
	if (( ! DRY_RUN )) && git diff --cached --quiet; then
		warn "después de 'git add -A' no quedó nada staged: salteo el commit"
	else
		if (( ! message_set )); then
			template="${APUS_MESSAGE_TEMPLATE:-chore: actualización {date\}}"
			MESSAGE="${template//\{date\}/$(date +"${APUS_DATE_FORMAT:-%Y-%m-%d %H:%M}")}"
		fi
		[[ -n "${MESSAGE//[[:space:]]/}" ]] || die "el mensaje de commit está vacío" 2

		run git commit -m "$MESSAGE" || die "el commit falló (¿lo rechazó un hook?)"
		committed=1
	fi
fi

if (( ! committed && ! has_head )); then
	ok "todavía no hay ningún commit para subir"
	exit 0
fi

# ─── push ────────────────────────────────────────────────────────────────────

if [[ -n "$upstream" ]]; then
	target="$upstream"
	REMOTE="${upstream%%/*}"
	do_push git push || die "el push falló: $branch → $target" 3
else
	resolve_remote
	target="$REMOTE/$branch"
	do_push git push -u "$REMOTE" "$branch" || die "el push falló: $branch → $target" 3
fi

if (( DRY_RUN )); then
	ok "dry-run: nada se ejecutó ($branch → $target)"
else
	ok "$branch → $target"
	url="$(browse_url "$(git remote get-url "$REMOTE" 2>/dev/null || true)")"
	[[ "$url" == https://* ]] && note "$url" || true
fi
