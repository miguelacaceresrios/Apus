<p align="center">
  <img src="images/icon.png" width="72" alt="Apus affinis">
</p>

<h1 align="center">Apus affinis</h1>

<p align="center">Tus repos se suben solos, y ves en qué anda cada uno sin salir de VS Code.</p>

<p align="center">
  <a href="https://github.com/miguelacaceresrios/apus-affinis/actions/workflows/ci.yml"><img src="https://github.com/miguelacaceresrios/apus-affinis/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/miguelacaceresrios/apus-affinis/releases/latest"><img src="https://img.shields.io/github/v/release/miguelacaceresrios/apus-affinis" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/miguelacaceresrios/apus-affinis" alt="Licencia"></a>
</p>

<p align="center"><a href="README.md">Read in English</a></p>

---

*Apus affinis* es el vencejo pequeño, pariente de *Apus*. Esta extensión lleva [apus](https://github.com/miguelacaceresrios/Apus) al editor. Vigila tus repos y, cuando dejás de tocar uno un rato, apus hace `add`, `commit` y `push`. En la barra ves si hay cambios esperando, cuánto falta para el próximo auto-commit y a qué hora fue el último push.

<p align="center">
  <img src="images/screenshots/view.png" width="900" alt="La vista Apus: portfolio vigilado, con 2 cambios y el próximo auto-commit en 4:55; api frenado por un archivo .env y un token en src/config.ts; notes todavía sin URL.">
</p>

## Qué hace

- **Barra de estado.** Muestra el ícono de apus con el estado del repo del editor activo:

  | En la barra | Qué significa |
  |---|---|
  | apus + `10:48` | Al día; el último push fue a las 10:48. |
  | apus + `3 · en 1:40` | 3 cambios esperando; el próximo auto-commit es en 1:40. |
  | apus + pausa + `2` | En pausa, con 2 cambios. |
  | apus + flechas girando | Subiendo. |
  | apus + escudo, con fondo amarillo | Frenado: está por subir algo que no debería. |
  | apus + cable desenchufado | Todavía no tiene URL a dónde subir. |
  | apus + advertencia, con fondo amarillo | Algo necesita tu atención. |

  Pasando el mouse ves el detalle y tenés acciones rápidas: pausar, subir ahora y ver los auto-commits. Con un clic abrís el menú.
- **Nada sensible se sube por accidente.** Antes de cada push, apus mira lo que está por salir de tu máquina: archivos `.env`, claves privadas, tokens pegados en un archivo y archivos demasiado grandes para GitHub. Mientras haya alguno, un auto-commit no sube nada; subir a mano pregunta antes. Ver [Revisión antes de subir](#revisión-antes-de-subir).
- **Menú.** Subir ahora, vigilar o pausar y los commits automáticos; después la carpeta y la URL; al final las reglas y el registro.
- **Vista Apus.** Tiene su propio ícono en la barra de actividad. Cada repo se abre como una ficha: su carpeta, la URL a la que sube, su rama y sus commits automáticos, con la cuenta regresiva en vivo y acciones. Con un clic en la carpeta o en la URL, las cambiás. El número sobre el ícono cuenta los repos con algo sin subir.
- **Carpeta y URL.** *Agregar carpeta…* mira la carpeta antes de sumarla: si es una carpeta común, ofrece inicializarla; si es una subcarpeta, ofrece la raíz de su repo; y si tiene repos adentro, te pregunta cuál querías. *Conectar o cambiar URL…* valida la URL y pregunta antes de cambiarla.
- **Errores con arreglo.** Sin URL, repo no encontrado, remoto adelantado: el aviso y la vista ofrecen el arreglo, no solo el mensaje. Si desaparece la carpeta de un repo, queda en la lista como *no está la carpeta*, para buscarla u olvidarla.
- **Notificaciones.** Elegís entre todos los auto-commits, solo los errores o nada. Un error repetido no se vuelve a avisar.
- **Aviso temprano.** Si falta apus, la barra y la vista lo dicen apenas arranca VS Code y ofrecen descargarlo o buscarlo. No te enterás recién en el primer push.
- **Guía de primeros pasos.** Un recorrido en la pantalla de Bienvenida que va desde instalar apus hasta vigilar tu primer repo.
- **Español e inglés.** La extensión sigue el idioma de VS Code.
- **Multi-root.** Maneja un controlador por repo git, no por carpeta del workspace. Los repos anidados funcionan.

## Requisitos

- [apus](https://github.com/miguelacaceresrios/Apus) 2.1 o superior, en el `PATH` o configurado en `apus.path`.
- La extensión Git de VS Code, que ya viene incluida.

Si la extensión no encuentra apus, ofrece descargarlo o elegir el binario. En Windows tiene que ser `apus.exe`: `apusw.exe` es la versión de ventana y muestra los errores en diálogos.

## Cómo funciona

La extensión no reimplementa git:

1. **Detecta los cambios** con la extensión Git de VS Code. Lo que está en `.gitignore` no cuenta.
2. **Espera** a que el repo quede quieto `apus.watchInterval` segundos. Cada archivo guardado reinicia la espera.
3. **Revisa** lo que subiría el push: las líneas nuevas desde el último commit, los archivos que git todavía no sigue y los commits que no están en ningún remoto. Si hay algo que no debería subir, se frena acá.
4. **Sube** llamando a `apus --message "…"`. El proceso se lanza sin shell, sin entrada estándar y con `GIT_TERMINAL_PROMPT=0`, así nunca se queda esperando una clave.
5. **Marca** el commit con el trailer `Apus-Auto: true`. Así se reconoce desde la extensión, desde la terminal o desde cualquier otra herramienta:

   ```bash
   git log --grep='^Apus-Auto: true$'
   ```

La hora del último push sale del reflog de la rama remota. La extensión no guarda ningún archivo propio: todo lo que muestra lo lee de git.

## Configuración

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| `apus.autoStart` | `false` | Vigila los repos apenas se abren. Apagado, cada repo se activa a mano. |
| `apus.watchInterval` | `120` | Segundos sin cambios antes del auto-commit. |
| `apus.minInterval` | `300` | Mínimo de segundos entre dos auto-commits del mismo repo. |
| `apus.ignorePatterns` | `[]` | Globs cuyos cambios no disparan un auto-commit, como `*.log` o `docs/**`. |
| `apus.messageTemplate` | `chore: auto-commit {date}` | Mensaje de los auto-commits. |
| `apus.checkBeforePush` | `true` | Revisar lo que está por subir. Solo desde tu configuración de usuario. |
| `apus.maxFileSize` | `50` | Tamaño máximo, en MB, de un archivo que se puede subir (GitHub rechaza los de más de 100 MB). Solo desde tu configuración de usuario. |
| `apus.notifications` | `all` | Qué avisar: `all`, `errors` u `off`. |
| `apus.logSize` | `20` | Cuántos commits automáticos listar. |
| `apus.path` | *(vacío)* | Ruta al binario de apus. Vacío: lo busca en el `PATH`. Solo desde tu configuración de usuario. |

`apus.ignorePatterns` decide **cuándo** subir, no **qué** se sube. Si hay otros cambios, apus hace `add -A` y los patrones ignorados entran igual. Para dejar archivos fuera de git, usá `.gitignore`.

"Solo desde tu configuración de usuario" quiere decir que el `.vscode/settings.json` de un repo no lo puede cambiar: un repo que clonás no puede apagar la revisión ni apuntar apus a otro ejecutable.

## Comandos

Están todos en la paleta de comandos, bajo **Apus**, y la mayoría queda a un clic en la vista o en el menú.

<p align="center">
  <img src="images/screenshots/menu.png" width="900" alt="El menú de un repo: subir ahora, pausar, commits automáticos, cambiar carpeta, cambiar URL, abrir en el navegador, quitar de apus, agregar carpeta, reglas, registro y primeros pasos.">
</p>

| Comando | Qué hace |
|---|---|
| Agregar carpeta… | Suma la carpeta de un proyecto a la lista. Si es una carpeta común, ofrece inicializarla; si tiene repos adentro, pregunta cuál. |
| Cambiar carpeta… | Apunta un repo de la lista a otra carpeta, y lo sigue vigilando si estaba vigilado. |
| Conectar o cambiar URL… | Define a dónde sube un repo. |
| Vigilar o pausar un repo | Prende o apaga el auto-commit, repo por repo. |
| Subir ahora | add + commit + push sin esperar, con la misma revisión. |
| Revisar lo frenado… | Qué frenó la última subida, con un botón para arreglar cada cosa. |
| Revisar lo que dejaste pasar… | Los avisos que marcaste como falsos, para volver a revisarlos. |
| Commits automáticos | Los últimos auto-commits; elegí uno para abrirlo en GitHub. |
| Quitar de apus | Saca un repo de la lista y deja de vigilarlo. |
| Reglas | Los ajustes `apus.*`. |
| Mostrar registro | Lo que hizo apus, comando por comando, con los tokens de las URLs tapados. |

## Revisión antes de subir

Un secreto que llega a GitHub hay que darlo por filtrado, aunque lo borres un minuto después. El auto-commit hace `git add -A` sin que nadie mire, así que antes de cada push la extensión mira exactamente lo que subiría:

- las líneas agregadas desde el último commit, y los archivos que git todavía no sigue (lo que deja afuera `.gitignore` no cuenta);
- los commits que todavía no están en ningún remoto, incluidos los que hiciste desde la terminal o desde Source Control.

| Frena | Ejemplos |
|---|---|
| Archivos de entorno | `.env`, `.env.local`, `prod.env` (no `.env.example`) |
| Claves y archivos de credenciales | `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx`, `*.jks`, `.netrc`, `.git-credentials`, `credentials.json`, `*.tfstate`, `*.kdbx` |
| Secretos dentro de un archivo | bloques de clave privada; tokens de GitHub, GitLab, npm y Slack; claves de acceso de AWS; claves de API de Google, OpenAI y Anthropic; claves de producción de Stripe; URLs con contraseña (`postgres://usuario:clave@host`) |
| Archivos grandes | Más de `apus.maxFileSize` (50 MB). GitHub rechaza cualquier archivo de más de 100 MB. |

Los ejemplos de documentación, como `your-token-here`, `${DB_PASSWORD}` o `AKIA…EXAMPLE`, no cuentan, y un secreto que ya estaba en el último commit no se vuelve a avisar en cada cambio.

**Cuando aparece algo**, un auto-commit no sube nada: el repo muestra un escudo y un aviso te dice qué y dónde. Subir a mano pregunta antes, y podés subir igual. **Revisar lo frenado…** lista cada aviso con su arreglo:

<p align="center">
  <img src="images/screenshots/held-back.png" width="900" alt="Revisar lo frenado: un archivo .env, con botones para agregarlo a .gitignore o dejarlo pasar, y un token de GitHub en la línea 1 de src/config.ts.">
</p>


- **Agregar a .gitignore**, para un archivo que git todavía no sigue.
- **Dejar de seguirlo**, para un archivo que ya está en git: queda en tu disco y pasa a `.gitignore`.
- **No es un secreto: dejarlo pasar**, para un aviso falso. Se recuerda por repo, y **Revisar lo que dejaste pasar…** lo deshace.

Si el secreto está en un commit que todavía no subiste, `.gitignore` no lo saca: deshacé ese commit (`git reset --soft`) y volvé a commitear sin eso.

**Lo que no hace.** Reconoce los formatos de arriba, no cualquier contraseña posible. No puede recuperar un secreto que ya se subió: cambiá ese secreto. Y subir desde la ventana o la terminal de apus todavía no pasa por esta revisión. Dejá prendidos también el secret scanning y la push protection de GitHub. El detalle está en [SECURITY.es.md](SECURITY.es.md).

## Cuidados

- **Nunca hace auto-commit** si hay conflictos sin resolver o si `HEAD` está desprendido.
- **Workspaces no confiables:** la extensión no corre. Necesita la extensión Git de VS Code, que ahí está desactivada.
- **Dos ventanas sobre el mismo repo no suben a la vez.** Hay un candado en `.git/apus.lock`, y el mínimo entre auto-commits se calcula desde git, así que vale entre ventanas.
- **Vigilar viene apagado.** Un push automático tiene que ser una decisión tuya, repo por repo.
- **Lo que se vigila es un repo, no una carpeta.** Si borrás un repo y clonás otro en la misma carpeta, el nuevo no queda vigilado.
- **Un repo dentro de otro tiene aviso.** git lo sube como un puntero vacío, no sus archivos, así que la extensión lo dice antes de que pase.
- **Las credenciales no se ven.** Las URLs se muestran sin usuario ni token, y el token que imprime apus se reemplaza por `***` antes de llegar al registro o a un aviso.
- **En segundo plano nunca pide claves.** Ni la terminal, ni la ventana de Git Credential Manager, ni el diálogo de la clave SSH: si faltan credenciales, el push falla y subir a mano lo resuelve.
- **Los ajustes de un repo no pueden colgar VS Code.** `apus.ignorePatterns` se compara sin expresiones regulares, así ningún patrón tarda minutos.

## Desarrollo

La estructura del proyecto y los comandos están en el [README en inglés](README.md#development).

## Licencia

[MIT](LICENSE)
