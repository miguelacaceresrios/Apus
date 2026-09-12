# apus

> *Apus* — género del vencejo común, el ave con vuelo nivelado más rápido que existe. Un solo comando para forjar y enviar tus cambios sin fricción.

Herramienta para automatizar el flujo `add` → `commit` → `push` en tus repositorios, sin repetir siempre lo mismo. Tiene una CLI y una interfaz visual que corre en Windows y en Linux por igual.

## Motivación

Subir cambios a un repo suele ser el mismo ritual repetitivo: `git add -A`, pensar un mensaje, `git commit`, `git push`, y a veces lidiar con el upstream faltante o con vincular la carpeta al repo de GitHub. Apus reduce todo eso a un solo comando — o a un par de clicks.

## Qué hace

- Un solo comando (`apus`) que encadena `add + commit + push`.
- Mensaje de commit autogenerado (fecha/hora) o mensaje propio.
- Detecta si falta configurar upstream y lo crea automáticamente.
- Si la carpeta no es un repo, ofrece iniciarlo; si no tiene remoto, te deja elegir uno de tu cuenta de GitHub, crear uno nuevo, o pegar una URL.
- Interfaz visual (`apus ui`) para ver todos tus repos, elegir archivos y subir con un click.
- Evita crear commits vacíos si no hay cambios staged.
- Código de salida distinto de 0 si el `push` falla, para poder encadenarlo con notificaciones u otros scripts.

## Dos implementaciones

| | [`apus.sh`](apus.sh) | binario Go (`apus`) |
|---|---|---|
| Requisitos | bash 4+, git | sólo git |
| Interfaz visual | no | sí (`apus ui`) |
| Windows | necesita Git Bash | nativo |
| Tamaño | 16 KB | ~9 MB, un solo archivo sin runtime |

Las dos se comportan igual en la terminal y pasan la misma batería de pruebas. El script queda para quien sólo quiere un archivo que leer de un vistazo; el binario es el que trae la interfaz.

## Uso

```bash
apus                        # commit con mensaje autogenerado (fecha/hora)
apus "fix: arreglo bug X"   # commit con mensaje propio
apus --link                 # cambiar el repo remoto y subir
apus ui                     # interfaz visual en el navegador
apus status                 # estado de todos tus repos
```

Opciones:

| Flag | Qué hace |
|------|----------|
| `-m, --message <msg>` | Mensaje de commit (igual que el argumento posicional). |
| `-l, --link` | Elegir/cambiar el repo remoto antes de subir. |
| `-n, --dry-run` | Muestra los comandos sin ejecutar nada. |
| `-q, --quiet` | Silencia la salida de apus. |
| `-h, --help` | Ayuda. |
| `-V, --version` | Versión. |

Funciona desde cualquier subdirectorio del repo.

## La interfaz visual

```bash
apus ui                    # busca repos en la carpeta actual
apus ui --dir ~/proyectos  # o donde vos le digas
```

Levanta un servidor en `127.0.0.1:7373` y abre la ventana (en modo app si encuentra Edge o Chrome; si no, en tu navegador). Es el mismo binario: no hay servicio, no hay nada instalado de más, y se corta con Ctrl+C.

```
┌─ apus ↑ ──────────────────────────────────────────────┐
│ ● segestria      3 cambios  │  segestria — main → origin/main
│ ↑ mcp-indexer    2 sin subir│    ☑ M  src/api.py
│ ○ apus           limpio     │    ☑ ?? notas.md
│                             │    ☐ M  .env.example
│                             │  [ chore: actualización … ] [Subir ↑]
└───────────────────────────────────────────────────────┘
```

- Lista todos los repos que encuentre (hasta 3 niveles de profundidad), ordenados por los que reclaman atención.
- Marcás con el mouse qué archivos entran en el commit; clic en el nombre para ver el diff.
- Si el repo no tiene remoto, la misma ventana te deja elegirlo de tu cuenta de GitHub, crear uno nuevo, o pegar una URL.
- Muestra el registro de cada comando git que ejecutó, y el error con su sugerencia si algo falla.
- Se refresca sola cada 6 segundos.

Sobre la seguridad: escucha sólo en `127.0.0.1`, y cada corrida genera un token que la terminal le pasa a la ventana (queda en una cookie). Sin ese token no atiende a nadie, así que ninguna otra página del navegador puede hablarle.

## Instalación

**Binario** (Windows, Linux, macOS — necesita [Go](https://go.dev/dl/) para compilar):

```bash
git clone https://github.com/<tu-usuario>/apus && cd apus
go build -o apus .            # en Windows: go build -o apus.exe .
```

Dejalo en el `PATH`: `install -Dm755 apus ~/.local/bin/apus` en Linux, o cualquier carpeta del `PATH` en Windows. Compila cruzado sin dependencias:

```bash
GOOS=linux   GOARCH=amd64 go build -o dist/apus .
GOOS=windows GOARCH=amd64 go build -o dist/apus.exe .
```

**Script de Bash** (Linux, o Windows con Git Bash):

```bash
curl -o ~/.local/bin/apus https://raw.githubusercontent.com/<tu-usuario>/apus/main/apus.sh
chmod +x ~/.local/bin/apus
```

`gh` ([GitHub CLI](https://cli.github.com/)) es opcional: sólo hace falta para elegir o crear repos de tu cuenta. Sin él, apus te pide la URL.

## Vinculación con GitHub

La primera vez que corrés `apus` en una carpeta nueva, se encarga de todo el trámite:

```console
$ apus "primer vuelo"
! esto no es un repositorio git: ~/proyectos/nuevo
? ¿lo inicializo acá? (S/n):
» git init -b main
» git add -A
» git commit -m 'primer vuelo'
! este repo todavía no tiene remoto

  tus repos
    1) gato/segestria                     private  2026-09-01
    2) gato/nuevo                         public   2026-09-10
    3) gato/mcp-telegram-indexer          private  2026-08-02
    n) crear un repo nuevo en GitHub
    u) pegar una URL
    q) cancelar
? elegí [2]:
✔ origin → gato/nuevo
» git push -u origin main
✔ main → origin/main
  https://github.com/gato/nuevo
```

- Si hay un repo con el mismo nombre que la carpeta, queda preseleccionado: alcanza con Enter.
- Con muchos repos, escribí `/texto` para filtrar la lista.
- La opción `u` acepta una URL completa (`https://…`, `git@…`), el atajo `usuario/repo`, o la ruta a un repo local.
- El protocolo (https o ssh) sale de tu `gh config get git_protocol`.

Sin terminal interactiva (cron, hooks, CI) apus no pregunta nada: falla con un mensaje claro.

## Configuración

Por ahora, variables de entorno:

| Variable | Por defecto | Qué hace |
|----------|-------------|----------|
| `APUS_MESSAGE_TEMPLATE` | `chore: actualización {date}` | Plantilla del mensaje autogenerado; `{date}` se reemplaza por la fecha/hora. |
| `APUS_DATE_FORMAT` | `%Y-%m-%d %H:%M` | Formato de fecha, estilo `date(1)`. |
| `APUS_REMOTE` | — | Remoto a usar cuando la rama no tiene upstream. |
| `APUS_DEFAULT_BRANCH` | `main` | Rama inicial cuando apus hace `git init`. |
| `APUS_REPOS_DIR` | carpeta actual | Dónde buscar repos para `apus ui` y `apus status`. |
| `NO_COLOR` | — | Salida sin colores. |

El registro de repos en `~/.config/apus/config` sigue en el roadmap:

```toml
default_branch = "main"
message_template = "chore: actualización {date}"

[[repos]]
path = "~/proyectos/segestria"
```

## Integración con la barra (Linux)

`apus status --json` escupe el formato que espera un módulo `custom` de Waybar:

```jsonc
// ~/.config/waybar/config
"custom/apus": {
    "exec": "apus status --json --dir ~/proyectos",
    "return-type": "json",
    "interval": 30,
    "on-click": "apus ui --dir ~/proyectos"
}
```

## Códigos de salida

| Código | Significado |
|--------|-------------|
| `0` | Todo bien (incluye "no había nada que hacer"). |
| `1` | Error de repo: HEAD desprendido, commit rechazado por un hook, vinculación cancelada, sin remoto y sin terminal. |
| `2` | Uso incorrecto. |
| `3` | El `push` falló (el commit ya quedó hecho: corregí y volvé a correr `apus`). |

Si el push se rechaza porque el remoto tiene commits que no tenés, apus te lo dice y sugiere `git pull --rebase`.

## Tests

```bash
./test.sh                 # prueba apus.sh
APUS_IMPL=go ./test.sh    # prueba el binario
```

31 casos: el flujo completo contra un bare local, la vinculación con un `gh` falso, los errores de uso, el push rechazado y los caminos sin terminal. Arma todo en un temporal y no toca tu configuración de git.

## Roadmap

- [x] CLI core en Bash (add + commit + push)
- [x] Vinculación interactiva: `git init`, elegir/crear repo de GitHub, pegar URL
- [x] Núcleo en Go: un binario sin dependencias, nativo en Windows y Linux
- [x] Interfaz visual multiplataforma (`apus ui`) con selección de archivos y diffs
- [x] `apus status --json` para el módulo custom de Waybar
- [ ] Config y registro de repos (multi-repo, plantillas de mensaje)
- [ ] Watcher en segundo plano (Go + `fsnotify`) que detecta cambios sin subir
- [ ] Persistencia: `systemd --user` en Linux, tarea programada en Windows
- [ ] Notificaciones cuando hay cambios pendientes hace rato (`notify-send` / toast)
- [ ] Ícono en la bandeja y atajo global
- [ ] Empaquetado (AUR/COPR, winget)

## Stack técnico

| Componente        | Tecnología                     |
|-------------------|--------------------------------|
| CLI                | Go (y Bash, la versión original) |
| Interfaz           | HTML/CSS/JS servidos por el binario (sin dependencias) |
| GitHub             | `gh` (opcional)                |
| Watcher            | Go + `fsnotify`                |
| Persistencia       | `systemd --user` / Task Scheduler |
| Integración visual | Waybar (módulo `custom`)       |

## Licencia

MIT
