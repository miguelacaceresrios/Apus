# Cambios

## 2.3.0 - 2026-10-12

- **apus-guard**: antes de subir, busca secretos escritos en el código con reglas fijas para .NET y Azure: contraseñas y usuarios de SQL Server en connection strings, `AccountKey` de Storage, `SharedAccessKey` de Service Bus y Event Hubs, claves con nombre de secreto en `appsettings*.json`, y connection strings armados en archivos `.cs`. Con algo crítico no sube nada. La ventana muestra cada hallazgo con archivo, línea, severidad, el valor tapado y qué hacer (`dotnet user-secrets`, variable de entorno, Key Vault o Managed Identity). No marca relleno como `CHANGE_ME`, `${VAR}` o referencias de Key Vault. También está en la terminal: `apus guard`.
- Con un token de GitHub (se guarda en el llavero del sistema, nunca en un archivo), apus-guard abre un issue por cada hallazgo crítico, sin repetir los que ya están abiertos.
- `apus guard init` (o **GitHub → Agregar a este repo** en la ventana) agrega un workflow de GitHub Actions que corre las mismas reglas en cada PR, comenta los hallazgos en su línea y falla el check si hay algo crítico.
- **Aerodramus**: apus-guard anota cada hallazgo en un log de la máquina, fuera de los repos y con el valor tapado, y Aerodramus es la ventana para revisarlo: los hallazgos agrupados por repo, con severidad y estado. Por cada uno: abrir el archivo en la línea exacta, copiar el arreglo, marcarlo resuelto o ignorarlo. Lo ignorado deja de frenar la subida. Se abre desde el menú Inicio o con `apus aerodramus`.
- **Push rechazado**: si GitHub tiene commits que la carpeta no tiene, la ventana ya no se queda en el error de git. Trae lo del remoto, ensaya el merge sin tocar la carpeta y ofrece una salida: **Traer y continuar** si no choca nada; si hay choques, muestra los archivos y deja elegir entre **Traer cambios remotos (rebase)** y **Sobrescribir remoto (force push)**, con advertencia y atado al commit que se vio. Si quedás a mitad de resolver, ofrece **Continuar** o **Cancelar**.
- **Instalar es abrir el programa.** Bajás `apusw.exe`, lo abrís, y pregunta si instalarlo: queda en el menú Inicio, en el escritorio y en el PATH, y se desinstala desde "Aplicaciones instaladas". Sin permisos de administrador. Si abrís una versión más nueva, ofrece actualizar la instalada. Con un solo `.exe` alcanza: el instalador arma el de la terminal, el de la ventana y el de Aerodramus.
- `apus install` y `apus uninstall`, también en Linux (`~/.local/bin` y el menú de aplicaciones) y macOS. Instaladores de una línea: `scripts/install.ps1` y `scripts/install.sh`.
- Logo nuevo: el vencejo (*Apus affinis*) visto desde abajo, sobre un cuadrado crema. Está en `assets/apus.svg` y los íconos salen de ahí; en los tamaños chicos va como silueta, para que se lea nítido en la barra de tareas.
- Los `.exe` tienen su ícono, nombre y versión. La ventana también: antes aparecía el globo de Edge.
- La ventana, rediseñada con los colores del vencejo, en tema claro y oscuro, sin imágenes adentro.
- Se fue `scripts/atajo.ps1`: el instalador hace los accesos.

## 2.2.0 - 2026-09-18

- `apus --json`: al terminar, una línea JSON en stdout con el desenlace (si hizo el commit, cuál, si subió, a dónde) y, si falló, el motivo en una palabra (`offline`, `auth`, `notFound`, `behind`, `noRemote`…). Los programas que usan apus, como la extensión de VS Code, ya no tienen que leer los mensajes en castellano. Con `--json` apus nunca pregunta nada.
- Sin conexión, el error lo dice: "sin conexión con el remoto", y que el commit quedó guardado. Antes era un "el push falló" sin pista.
- El repo de la URL que no existe (borrado, renombrado o sin acceso) también tiene su pista.

**Arreglos**

- Después de subir, apus mostraba la URL del remoto tal cual: si tenía un token (`https://usuario:token@github.com/…`), se imprimía. Ahora sale sin usuario ni token.

## 2.1.0 - 2026-09-17

- Ventana nueva: **carpeta + URL + Subir**. Si la carpeta no es un repo lo inicializa, pone la URL como `origin` y sube todo.
- Avisa antes de cambiar el remoto de una carpeta, se niega a subir una subcarpeta de otro repo y explica el rechazo cuando el repo de GitHub ya tiene archivos.
- `apusw.exe`: el binario de ventana para Windows. No abre terminal, ni la suya ni la de cada `git`; los errores aparecen en un cuadro de diálogo.
- Si el puerto 7373 está ocupado, la ventana usa uno libre en vez de fallar.
- El servidor local además valida la cabecera `Host`.
- Proyecto ordenado en `assets/`, `scripts/`, `tools/` y `ui/`; builds en `dist/`; CI en GitHub Actions.
- Pruebas de Go para el flujo de la ventana y para la detección del binario de ventana.
- Binarios un 30% más chicos (sin información de depuración).

**Arreglos**

- `apus.sh` leía las respuestas de la terminal aunque llegaran por un pipe, y se quedaba esperando el teclado.
- Los scripts de PowerShell no andaban en Windows PowerShell 5.1: sin BOM, los acentos y el guion largo rompían el parseo.
- El estado "rama sin publicar" se mostraba como "sin remoto".
- Se quitó código muerto (`FileChange.Label`, `Repo.Clean`, el campo `Behind` y el parámetro `paths` de `Push`).

## 2.0.0

- apus deja de crear repos y de elegirlos desde tu cuenta de GitHub: el remoto lo decidís vos.
- Se quitan `--link` y la dependencia de `gh`.
- La ventana pasa a ser una lista con un botón **Subir** por repo.
- Se distingue "sin remoto" de "rama sin publicar".

## 1.2.0

- Binario en Go, nativo en Windows y Linux, con la misma batería de pruebas que el script.
- `apus ui`: interfaz en el navegador, servida por el mismo binario.
- `apus status` (y `--json` para Waybar).
- Atajo de escritorio con ícono propio, que se apaga al cerrar la ventana.

## 1.1.0

- Vinculación interactiva: `git init`, elegir o crear el repo en GitHub, o pegar una URL.

## 1.0.0

- `apus.sh`: `add` + `commit` + `push` en un comando, con mensaje automático, upstream automático y códigos de salida.
