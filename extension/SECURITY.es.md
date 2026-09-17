# Seguridad

[Read in English](SECURITY.md)

Apus affinis hace commit y push de tu código sin preguntarte cada vez. Eso solo es aceptable si no se puede usar en tu contra: ni un repo que clonás, ni un secreto que te olvidaste en una carpeta, ni un token en un registro. Esta página cuenta qué hace la extensión en tu máquina, de qué te protege y hasta dónde llega.

## Reportar una vulnerabilidad

No abras un issue público. Usá **Report a vulnerability** en la pestaña **Security** de este repo, que manda un reporte privado. Incluí la versión de la extensión (vista de Extensiones → Apus affinis), tu sistema operativo y los pasos para reproducirlo.

Solo la última versión recibe arreglos.

## Qué hace la extensión en tu máquina

- **Corre dos programas:** `git`, el mismo que usa la extensión Git de VS Code, y `apus`, desde `apus.path` o tu `PATH`. Los dos se lanzan sin shell y sin entrada estándar, así nada de un nombre de archivo, un mensaje de commit o una URL se interpreta como un comando.
- **Escribe en un repo solo** si lo pusiste a vigilar (commit y push, a través de apus) o si tocás una acción: `git init`, `git remote add` o `set-url`, `git rm --cached`, y una línea agregada a `.gitignore`.
- **Recuerda, en el almacenamiento de VS Code:** qué repos se vigilan (con su commit raíz, así otro repo clonado en la misma carpeta no hereda la vigilancia), las carpetas que agregaste en cada ventana y los avisos que dejaste pasar. No guarda archivos propios.
- **No se conecta a nada por su cuenta.** Los que suben son git y apus. No hay telemetría.

## Lo que viene de un repo no es confiable

El contenido de un repo, su `.vscode/settings.json`, los nombres de archivo, los mensajes de commit, las URLs de los remotos y todo lo que imprimen git o apus se tratan como entrada no confiable.

| Riesgo | Qué hace la extensión |
|---|---|
| Un repo clonado apunta la extensión a otro ejecutable | `apus.path` tiene alcance de máquina: VS Code lo ignora en la configuración del workspace. |
| Un repo clonado apaga la revisión, o deja pasar su propio `.env` | `apus.checkBeforePush` y `apus.maxFileSize` tienen alcance de máquina. Lo que dejaste pasar vive en el estado global de VS Code, no en un archivo de configuración. |
| Un patrón de `apus.ignorePatterns` cuelga VS Code | Los patrones se comparan por partes, sin expresiones regulares, en un tiempo proporcional a patrón × ruta. Se rechazan los de más de 1000 caracteres o más de 64 variantes entre llaves. |
| Una URL de remoto mete una opción de git o un transporte que ejecuta comandos | Las URLs se validan antes de `git remote add` o `set-url`: https, http, ssh, git, file, `usuario@host:ruta` o una ruta absoluta. Nada que empiece con `-`, y nada de `ext::`. |
| Un link de un tooltip corre cualquier comando | Los tooltips solo pueden correr comandos de la propia extensión, y el texto que viene de un repo se inserta como texto plano. |
| Correr git en una carpeta no confiable | VS Code desactiva su extensión Git en los workspaces no confiables, y esta extensión depende de ella, así que ahí no corre. |

## Revisión antes de subir

Antes de cada push, automático o a mano, la extensión mira lo que subiría: las líneas agregadas desde el último commit, los archivos que git todavía no sigue y los commits que no están en ningún remoto (incluidos los que se hicieron desde la terminal). Frena:

| Regla | Qué busca |
|---|---|
| Archivo de entorno | `.env`, `.env.*`, `*.env`, salvo los nombres con `example`, `sample`, `template`, `dist` o `default` |
| Clave privada SSH | `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` (no `.pub`) |
| Almacén de claves o certificados | `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk` |
| Archivo de credenciales | `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `.pypirc`, `.htpasswd`, `.dockercfg`, `credentials.json`, `client_secret*.json`, `*service-account*.json`, `secrets.json`/`.yml`/`.toml`, `.aws/credentials` |
| Estado de Terraform | `*.tfstate`, `*.tfstate.backup` |
| Base de contraseñas | `*.kdbx`, `*.kdb`, `*.agilekeychain`, `*.1pif` |
| Clave privada | un bloque `-----BEGIN … PRIVATE KEY-----` |
| Tokens y claves | GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), GitLab (`glpat-`), npm (`npm_`), Slack (`xox…-`), claves de acceso de AWS (`AKIA`, `ASIA`), claves de API de Google (`AIza`), OpenAI, Anthropic, claves de producción de Stripe (`sk_live_`, `rk_live_`) |
| URL con contraseña | `esquema://usuario:contraseña@host` |
| Archivo grande | más de `apus.maxFileSize` (50 MB por defecto; GitHub rechaza cualquier archivo de más de 100 MB) |

Solo avisa formatos que puede reconocer con seguridad, porque una revisión que avisa de más termina ignorada. Los ejemplos (`example`, `your…`, `xxxxxx`, `${VAR}`, `<token>`, `***`) no cuentan. Un auto-commit con un aviso no sube nada y dice por qué; subir a mano pregunta, y la decisión es tuya. Cada aviso y cada "subir igual" quedan en el registro, sin el secreto.

Los secretos falsos de los tests de este repo se arman al correr, así el código no tiene ninguno escrito.

## Credenciales

- **Nunca se muestran.** Las URLs de los remotos se ven como `github.com/usuario/repo`, sin usuario, contraseña ni token.
- **Se tapan en el registro y en los avisos.** apus imprime la URL del remoto tal como está configurada; si trae `usuario:token@`, la extensión la reemplaza por `***@` antes de guardar o mostrar esa salida. Lo mismo con los mensajes de error de git.
- **Nunca se piden en segundo plano.** Los auto-commits corren con `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` y `SSH_ASKPASS_REQUIRE=never`: mientras trabajás no aparece ni un pedido en la terminal, ni la ventana de Git Credential Manager, ni el diálogo de la clave SSH. Subir a mano sí puede mostrar Git Credential Manager, como cualquier push.
- **No se repiten.** Si cambiás una URL que trae credenciales, el cuadro empieza vacío en vez de mostrar la anterior.

## Límites conocidos

- **Reconoce formatos, no intenciones.** Una contraseña en un archivo de configuración sin un formato conocido no se detecta. Dejá prendidos también el [secret scanning y la push protection](https://docs.github.com/es/code-security/secret-scanning) de tus repos en GitHub.
- **No puede recuperar lo que ya se subió.** Si un secreto llegó a un remoto, cambiá el secreto; sacarlo del historial no lo vuelve seguro.
- **apus solo todavía no pasa por la revisión.** Subir desde la ventana de apus o desde la terminal va directo a `git push`.
- **Los cambios enormes se revisan en parte.** Más de 500 commits sin subir, diffs de más de 16 MB, archivos de más de 2 MB o más de 5000 archivos para leer: se revisa lo que entra, y el registro avisa que la revisión fue parcial.
- **Los archivos binarios se revisan por nombre y tamaño**, no por contenido.
