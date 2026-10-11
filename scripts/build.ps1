# Compila apus para Windows en dist/.
#
#   .\scripts\build.ps1            # compila
#   .\scripts\build.ps1 -Test      # compila y corre todas las pruebas
#   .\scripts\build.ps1 -Install   # compila e instala esta versión (menú Inicio, escritorio y PATH)
#
# Deja dos binarios del mismo código:
#   dist\apus.exe    para la terminal
#   dist\apusw.exe   la ventana: sin consola, la del menú Inicio y el escritorio

param([switch]$Test, [switch]$Install)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
	& $cmd
	if ($LASTEXITCODE -ne 0) { throw "falló: $what" }
}

try {
	New-Item -ItemType Directory -Force dist | Out-Null

	Invoke-Checked "go build (terminal)" { go build -trimpath -ldflags "-s -w" -o dist/apus.exe . }
	Invoke-Checked "go build (ventana)"  { go build -trimpath -ldflags "-s -w -H=windowsgui" -o dist/apusw.exe . }

	foreach ($bin in "apus.exe", "apusw.exe") {
		$size = (Get-Item "dist/$bin").Length / 1MB
		Write-Host ("  dist\{0,-10} {1,5:N1} MB" -f $bin, $size)
	}

	if ($Test) {
		Invoke-Checked "go vet"  { go vet ./... }
		Invoke-Checked "go test" { go test ./... }
		Invoke-Checked "scripts/test.sh (bash)" { bash scripts/test.sh }
		$env:APUS_IMPL = "go"
		try { Invoke-Checked "scripts/test.sh (go)" { bash scripts/test.sh } }
		finally { Remove-Item Env:APUS_IMPL }
	}

	if ($Install) {
		# apus cuenta lo que hace por stderr: con Stop, PowerShell 5.1 lo tomaría
		# por un error si la salida está redirigida.
		$ErrorActionPreference = "Continue"
		Invoke-Checked "apus install" { & dist/apus.exe install }
	}
}
finally {
	Pop-Location
}
