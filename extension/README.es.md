<p align="center">
  <img src="images/icon.png" width="72" alt="Apus affinis">
</p>

<h1 align="center">Apus affinis</h1>

<p align="center">Tus repos se suben solos, y ves en qué anda cada uno sin salir de VS Code.</p>

<p align="center"><a href="README.md">Read in English</a></p>

---

*Apus affinis* es el vencejo pequeño, pariente de *Apus*. Esta extensión lleva [apus](https://github.com/miguelacaceresrios/Apus) al editor. Vigila tus repos y, cuando dejás de tocar uno un rato, apus hace `add`, `commit` y `push`. En la barra ves si hay cambios esperando, cuánto falta para el próximo auto-commit y a qué hora fue el último push.

## Qué hace

- **Barra de estado.** Muestra el ícono de apus con el estado del repo del editor activo:

  | En la barra | Qué significa |
  |---|---|
  | apus + `10:48` | Al día; el último push fue a las 10:48. |
  | apus + `3 · en 1:40` | 3 cambios esperando; el próximo auto-commit es en 1:40. |
  | apus + pausa + `2` | En pausa, con 2 cambios. |
  | apus + flechas girando | Subiendo. |
  | apus + advertencia, con fondo amarillo | Algo necesita tu atención. |

  Pasando el mouse ves el detalle y tenés acciones rápidas: pausar, subir ahora y ver los auto-commits. Con un clic abrís el menú.
- **Menú.** Vigilar o pausar, subir ahora, ver los últimos commits automáticos y abrir las reglas.
- **Vista Apus.** Tiene su propio ícono en la barra de actividad. Cada repo es un renglón con su estado, la cuenta regresiva en vivo y acciones. El número sobre el ícono cuenta los repos con algo sin subir.
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
3. **Sube** llamando a `apus --message "…"`. El proceso se lanza sin shell, sin entrada estándar y con `GIT_TERMINAL_PROMPT=0`, así nunca se queda esperando una clave.
4. **Marca** el commit con el trailer `Apus-Auto: true`. Así se reconoce desde la extensión, desde la terminal o desde cualquier otra herramienta:

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
| `apus.notifications` | `all` | Qué avisar: `all`, `errors` u `off`. |
| `apus.logSize` | `20` | Cuántos commits automáticos listar. |
| `apus.path` | *(vacío)* | Ruta al binario de apus. Vacío: lo busca en el `PATH`. |

`apus.ignorePatterns` decide **cuándo** subir, no **qué** se sube. Si hay otros cambios, apus hace `add -A` y los patrones ignorados entran igual. Para dejar archivos fuera de git, usá `.gitignore`.

## Cuidados

- **Nunca hace auto-commit** si hay conflictos sin resolver, si `HEAD` está desprendido o si el workspace no es confiable.
- **Dos ventanas sobre el mismo repo no suben a la vez.** Hay un candado en `.git/apus.lock`, y el mínimo entre auto-commits se calcula desde git, así que vale entre ventanas.
- **`apus.path` solo se configura a nivel máquina.** Un repo clonado no puede traer en su `.vscode/settings.json` una ruta a otro ejecutable.
- **Vigilar viene apagado.** Un push automático tiene que ser una decisión tuya, repo por repo.

## Desarrollo

La estructura del proyecto y los comandos están en el [README en inglés](README.md#development).

## Licencia

[MIT](LICENSE)
