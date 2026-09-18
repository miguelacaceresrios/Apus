# Cambios

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
