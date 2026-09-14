<p align="center">
  <img src="images/icon.png" width="72" alt="Apus affinis">
</p>

<h1 align="center">Apus affinis</h1>

<p align="center">Tus repos se suben solos, y ves en qué andan sin salir de VS Code.</p>

---

*Apus affinis* es el vencejo pequeño, pariente de *Apus*. Esta extensión es eso para [apus](https://github.com/miguelacaceresr/apus): lo lleva al editor. Vigila tus repos y, cuando dejás de tocarlos un rato, hace `add`, `commit` y `push` con apus. En la barra ves si hay cambios pendientes y a qué hora fue el último push.

## Qué hace

- **Barra de estado.** El repo del editor activo muestra si está vigilado, cuántos cambios tiene sin subir y la hora del último push. Con un clic abrís el menú.
- **Menú rápido.** Desde ahí podés vigilar o pausar el repo, subir ahora, ver los últimos commits automáticos y abrir las reglas.
- **Vista Apus.** En la barra de actividad hay un renglón por repo, con su estado y acciones para vigilar, pausar o subir. El número del ícono cuenta cuántos repos tienen algo sin subir.
- **Notificaciones.** Avisa cada auto-commit o solo los errores. Un error repetido no se vuelve a avisar.
- **Multi-root.** Maneja un controlador por repo git, no por carpeta del workspace. Los repos anidados funcionan.

## Requisitos

- [apus](https://github.com/miguelacaceresr/apus) 2.1 o superior, en el `PATH` o configurado en `apus.path`.
- La extensión Git de VS Code, que ya viene incluida.

Si la extensión no encuentra apus, te ofrece elegir el binario. En Windows tiene que ser `apus.exe`: `apusw.exe` es la versión de ventana y muestra los errores en diálogos.

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

```
apus-affinis/
├── src/
│   ├── extension.ts        arranque: conecta las piezas
│   ├── commands.ts         comandos
│   ├── config.ts           lectura validada de apus.*
│   ├── apusBinary.ts       dónde está apus y qué hacer si no está
│   ├── core/               sin dependencias de VS Code, con pruebas
│   │   ├── apus.ts         llamada a apus y lectura de su salida
│   │   ├── binary.ts       búsqueda del binario
│   │   ├── git.ts          commits automáticos, último push, URL del remoto
│   │   ├── glob.ts         apus.ignorePatterns
│   │   ├── lock.ts         candado entre procesos
│   │   ├── process.ts      procesos sin shell
│   │   ├── scheduler.ts    cuándo volar
│   │   └── time.ts
│   ├── git/api.ts          API de la extensión Git de VS Code
│   ├── repos/              un controlador por repo, y el registro de todos
│   └── ui/                 barra de estado, vista, menú y notificaciones
├── test/unit/              pruebas de core/ con node:test
└── images/                 ícono del Marketplace y de la barra de actividad
```

```bash
npm install
npm test               # typecheck de las pruebas + node:test
npm run compile        # typecheck + bundle con esbuild en dist/
npm run install-ext    # empaqueta el .vsix y lo instala en tu VS Code
```

Con **F5** se abre una ventana de VS Code con la extensión cargada desde el código.

## Licencia

[MIT](LICENSE)
