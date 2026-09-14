Quiero que me ayudes a crear una extensión de VS Code llamada "Apus Companion" 
(o el nombre que consideres mejor, manteniendo la convención de nombres científicos 
de especies que uso en mis otras herramientas: Apus, Segestria).

CONTEXTO DEL PROYECTO BASE (Apus):
Apus es una herramienta CLI que actualmente encadena `git add + commit + push` en 
un solo comando. El roadmap planeado para Apus es:
1. CLI en Bash (ya en desarrollo)
2. Watcher en segundo plano hecho en Go + fsnotify, que detecta cambios en el repo
3. Servicio systemd --user para correr el watcher persistentemente
4. Módulo custom de Waybar para mostrar el estado en la barra
5. Notificaciones vía notify-send

OBJETIVO DE ESTA EXTENSIÓN:
Llevar esa misma visibilidad y control de Apus al editor, para quienes trabajan 
en VS Code en vez de (o además de) un entorno Linux con Waybar.

FUNCIONALIDADES QUE QUIERO EN LA V1:
1. Item en la barra de estado (status bar) de VS Code que muestre el estado actual 
   de Apus para el repo abierto: si el watcher está activo, si hay cambios 
   pendientes de auto-commit, y la hora del último push automático.
2. Click en ese item debe abrir un menú rápido (QuickPick) con opciones:
   - Activar/desactivar el watcher para este repo
   - Forzar un add+commit+push manual ahora mismo
   - Ver el log de los últimos N commits automáticos hechos por Apus
   - Abrir la configuración de reglas (ej: intervalo mínimo entre auto-commits, 
     patrones de archivos a ignorar)
3. Un panel lateral (Tree View) que liste los repos donde Apus está activo, 
   con su estado individual.
4. Notificaciones nativas de VS Code (en vez de notify-send) cuando Apus hace 
   un commit/push automático, con opción de deshabilitarlas.
5. Configuración vía settings.json de VS Code (apus.watchInterval, 
   apus.ignorePatterns, apus.autoStart, etc.)

DECISIONES TÉCNICAS A DEFINIR JUNTOS:
- ¿La extensión debe comunicarse con el watcher en Go vía socket/named pipe, 
  o debe reimplementar la lógica de watch directamente en TypeScript usando 
  la API de FileSystemWatcher de VS Code? Quiero que me des pros/contras de 
  cada enfoque antes de decidir.
- Cómo estructurar el proyecto (Yeoman generator para extensiones de VS Code, 
  esbuild para el bundling).
- Cómo manejar múltiples repos abiertos en un mismo workspace (multi-root).

STACK Y ESTILO:
- TypeScript estricto.
- Si necesitas ejecutar comandos de Apus (CLI en Bash) desde la extensión, 
  usa child_process de forma segura, sin shell injection.
- Estructura el código pensando en que después voy a querer publicarla en el 
  Marketplace de VS Code como parte de mi portafolio, así que cuida el README, 
  el ícono, y el package.json (categorías, keywords, etc.) desde el principio.

Empecemos por: revisar si ya tengo el repo de Apus en este entorno (o pídeme la 
ruta), proponer la estructura de carpetas del proyecto de la extensión, y 
después la decisión socket-vs-TypeScript-watcher antes de escribir código.