# Instala apus en Windows, en una línea:
#
#   irm https://raw.githubusercontent.com/miguelacaceresrios/Apus/master/scripts/install.ps1 | iex
#
# Baja la última versión y corre 'apus install': queda en el menú Inicio, en el
# escritorio y en el PATH. Sin permisos de administrador. Para sacarlo, desde
# "Aplicaciones instaladas" o con 'apus uninstall'.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # la barra de progreso hace lentísimo a Invoke-WebRequest

$suffix = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { '-windows-arm64' } else { '' }
$url = "https://github.com/miguelacaceresrios/Apus/releases/latest/download/apus$suffix.exe"
$tmp = Join-Path $env:TEMP "apus-install-$PID.exe"

Write-Host "Descargando apus..."
try {
	Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing
	& $tmp install
	if ($LASTEXITCODE -ne 0) { throw "la instalación falló (código $LASTEXITCODE)" }
}
finally {
	Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
