#!/usr/bin/env bash
#
# apus — un solo comando para forjar y enviar tus cambios.
#
#   apus                      commit con mensaje autogenerado (fecha/hora)
#   apus "fix: arreglo bug X" commit con mensaje propio
#   apus --link               elegir/cambiar el repo remoto
#
# Encadena add + commit + push. Si la carpeta no es un repo, ofrece iniciarlo;
# si no tiene remoto, te deja elegir uno de tu cuenta de GitHub (vía gh), crear
# uno nuevo o pegar una URL. Evita commits vacíos y devuelve un código de salida
# distinto de 0 si el push falla.

set -euo pipefail

APUS_VERSION="1.1.0"

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

have() { command -v "$1" >/dev/null 2>&1; }

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

# ¿Hay con quién hablar? Una terminal, una tty aunque stdin esté redirigido, o
# algo del otro lado de un pipe. Con la entrada vacía (cron, hooks) no preguntamos.
can_prompt() {
	[[ -t 0 ]] && return 0
	( : </dev/tty ) 2>/dev/null && return 0
	[[ -p /dev/stdin ]]
}

# Lee una línea: primero de la terminal, y si no se puede abrir, de stdin.
prompt_read() {
	local __var="$1"
	if [[ -r /dev/tty ]] && IFS= read -r "$__var" 2>/dev/null </dev/tty; then
		return 0
	fi
	IFS= read -r "$__var" || return 1
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

# ─── vinculación con el remoto ───────────────────────────────────────────────

GH_PROTO='https'
LINK_URL=''
LINK_NAME=''
_names=(); _metas=(); _urls=()

gh_ready() { have gh && gh auth status >/dev/null 2>&1; }

gh_protocol() {
	local p=''
	p="$(gh config get git_protocol 2>/dev/null || true)"
	if [[ "$p" == ssh ]]; then printf 'ssh'; else printf 'https'; fi
}

# URL navegable (https, sin .git) para mostrar al final.
browse_url() {
	local u="$1" host path
	case "$u" in
		git@*:*)     host="${u#git@}"; host="${host%%:*}"; path="${u#*:}"; u="https://$host/$path" ;;
		ssh://git@*) u="https://${u#ssh://git@}" ;;
	esac
	printf '%s' "${u%.git}"
}

load_gh_repos() {
	_names=(); _metas=(); _urls=()
	local full vis url ssh upd
	while IFS=$'\t' read -r full vis url ssh upd; do
		[[ -n "$full" ]] || continue
		_names+=("$full")
		_metas+=("$(printf '%-8s %s' "${vis,,}" "${upd%%T*}")")
		if [[ "$GH_PROTO" == ssh ]]; then _urls+=("$ssh"); else _urls+=("$url"); fi
	done < <(gh repo list --limit 200 \
		--json nameWithOwner,visibility,url,sshUrl,updatedAt \
		--jq '.[] | [.nameWithOwner, .visibility, .url, .sshUrl, .updatedAt] | @tsv' 2>/dev/null || true)
}

create_gh_repo() { # create_gh_repo <nombre-sugerido>
	local name='' vis='' owner=''
	gh_ready || { warn "para crear el repo necesitás gh con sesión iniciada: 'gh auth login'"; return 1; }
	ask name "nombre del repo nuevo" "$1" || return 1
	[[ -n "$name" ]] || { warn "nombre vacío"; return 1; }
	ask vis "visibilidad" "private" || return 1
	case "${vis,,}" in
		private|priv|p) vis=private ;;
		public|pub|pu)  vis=public ;;
		*) warn "visibilidad desconocida: '$vis' (private o public)"; return 1 ;;
	esac
	run gh repo create "$name" "--$vis" || { warn "gh no pudo crear el repo"; return 1; }
	if [[ "$name" == */* ]]; then
		owner="${name%%/*}"; name="${name#*/}"
	else
		owner="$(gh api user --jq .login 2>/dev/null || true)"
		[[ -n "$owner" ]] || { warn "no pude averiguar tu usuario de GitHub"; return 1; }
	fi
	LINK_NAME="$owner/$name"
	if [[ "$GH_PROTO" == ssh ]]; then
		LINK_URL="git@github.com:$owner/$name.git"
	else
		LINK_URL="https://github.com/$owner/$name.git"
	fi
}

ask_url() {
	local input=''
	ask input "URL del repo (o usuario/repo)" || return 1
	[[ -n "$input" ]] || { warn "no ingresaste nada"; return 1; }
	case "$input" in
		*://*|git@*:*)
			LINK_URL="$input" ;;
		*)
			if [[ "$input" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
				if [[ "$GH_PROTO" == ssh ]]; then
					LINK_URL="git@github.com:$input.git"
				else
					LINK_URL="https://github.com/$input.git"
				fi
			elif [[ -d "$input" ]]; then
				LINK_URL="$input"   # un repo local también es un remoto válido
			else
				warn "no entiendo '$input': pegá una URL completa o usá usuario/repo"
				return 1
			fi ;;
	esac
	LINK_NAME="$(browse_url "$LINK_URL")"
	LINK_NAME="${LINK_NAME#https://}"
}

choose_repo() { # choose_repo <nombre-de-la-carpeta>
	local folder="$1" filter='' choice='' def='' i idx shown
	for i in "${!_names[@]}"; do
		if [[ "${_names[$i]##*/}" == "$folder" ]]; then def="$((i+1))"; break; fi
	done
	[[ -n "$def" ]] || def='n'

	while :; do
		printf '\n' >&2
		if (( ${#_names[@]} )); then
			printf '%s\n' "  ${C_BOLD}tus repos${C_RESET}${filter:+ ${C_DIM}(filtro: $filter)${C_RESET}}" >&2
			shown=0
			for i in "${!_names[@]}"; do
				[[ -z "$filter" || "${_names[$i]}" == *"$filter"* ]] || continue
				if (( shown >= 15 )); then
					printf '%s\n' "  ${C_DIM}… hay más: filtrá escribiendo /texto${C_RESET}" >&2
					break
				fi
				printf '  %3d) %-34s %s\n' "$((i+1))" "${_names[$i]}" "${C_DIM}${_metas[$i]}${C_RESET}" >&2
				shown=$(( shown + 1 ))
			done
			(( shown )) || printf '%s\n' "  ${C_DIM}(ningún repo coincide con '$filter')${C_RESET}" >&2
		fi
		printf '%s\n' "    ${C_BOLD}n${C_RESET}) crear un repo nuevo en GitHub" >&2
		printf '%s\n' "    ${C_BOLD}u${C_RESET}) pegar una URL" >&2
		printf '%s\n' "    ${C_BOLD}q${C_RESET}) cancelar" >&2

		ask choice "elegí" "$def" || return 1
		case "$choice" in
			/*)   filter="${choice#/}"; continue ;;
			q|Q)  return 1 ;;
			n|N)  if create_gh_repo "$folder"; then return 0; else warn "probá de nuevo"; continue; fi ;;
			u|U)  if ask_url; then return 0; else warn "probá de nuevo"; continue; fi ;;
			''|*[!0-9]*) warn "no entiendo '$choice'"; continue ;;
			*)
				idx=$(( choice - 1 ))
				if (( idx >= 0 && idx < ${#_names[@]} )); then
					LINK_URL="${_urls[$idx]}"; LINK_NAME="${_names[$idx]}"
					return 0
				fi
				warn "el $choice no está en la lista"; continue ;;
		esac
	done
}

link_remote() {
	local folder
	folder="$(basename "$PWD")"
	GH_PROTO="$(gh_protocol)"

	if gh_ready; then
		load_gh_repos
	elif have gh; then
		warn "gh está instalado pero sin sesión: corré 'gh auth login' para elegir de tus repos"
	else
		warn "gh no está instalado: por ahora sólo puedo tomar una URL (instalalo para elegir de tu cuenta)"
	fi

	LINK_URL=''; LINK_NAME=''
	if (( ${#_names[@]} == 0 )) && ! gh_ready; then
		ask_url || die "no elegiste ningún remoto"
	else
		choose_repo "$folder" || die "vinculación cancelada"
	fi
	[[ -n "$LINK_URL" ]] || die "no elegiste ningún remoto"

	if git remote get-url origin >/dev/null 2>&1; then
		run git remote set-url origin "$LINK_URL"
	else
		run git remote add origin "$LINK_URL"
	fi
	REMOTE='origin'
	ok "origin → ${LINK_NAME:-$LINK_URL}"
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
		can_prompt || die "el repo no tiene remotos: agregá uno con 'git remote add origin <url>'"
		warn "este repo todavía no tiene remoto"
		link_remote
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
  -l, --link            Elegir/cambiar el repo remoto antes de subir.
  -n, --dry-run         Muestra los comandos sin ejecutar nada.
  -q, --quiet           Silencia la salida de apus (no la de git).
  -h, --help            Esta ayuda.
  -V, --version         Versión.

MENSAJE
  Sin mensaje, apus lo genera desde la plantilla por defecto:
      chore: actualización {date}

VINCULACIÓN
  Si la carpeta no es un repo, apus ofrece iniciarlo. Si el repo no tiene
  remoto (o si pasás --link), apus te deja:
    · elegir uno de los repos de tu cuenta de GitHub (necesita 'gh' con sesión),
    · crear uno nuevo ahí mismo ('gh repo create'),
    · o pegar una URL / usuario/repo.
  Después publica la rama con 'git push -u origin <rama>'.

VARIABLES DE ENTORNO
  APUS_MESSAGE_TEMPLATE   plantilla del mensaje; {date} se reemplaza por la fecha.
  APUS_DATE_FORMAT        formato para date(1) (por defecto '%Y-%m-%d %H:%M').
  APUS_REMOTE             remoto a usar cuando la rama no tiene upstream.
  APUS_DEFAULT_BRANCH     rama inicial al hacer 'git init' (por defecto 'main').
  NO_COLOR                salida sin colores.

CÓDIGOS DE SALIDA
  0  todo bien (incluye "no había nada que hacer")
  1  error de repo (HEAD desprendido, commit rechazado, vinculación cancelada)
  2  uso incorrecto
  3  el push falló
USAGE
}

# ─── argumentos ──────────────────────────────────────────────────────────────

MESSAGE=''
message_set=0
LINK=0

while (( $# )); do
	case "$1" in
		-m|--message)
			(( $# >= 2 )) || die "-m necesita un mensaje" 2
			MESSAGE="$2"; message_set=1; shift 2 ;;
		--message=*)
			MESSAGE="${1#*=}"; message_set=1; shift ;;
		-l|--link)    LINK=1; shift ;;
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

# --link: elegir el remoto antes que nada, y no cortar por "nada que hacer".
if (( LINK )); then
	can_prompt || die "--link necesita una terminal interactiva"
	link_remote
	upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
	unpushed=1
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
