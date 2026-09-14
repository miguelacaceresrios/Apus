# Crea (o rehace) el atajo de apus en el escritorio de Windows.
#
#   .\scripts\atajo.ps1                                  # el selector arranca en el escritorio
#   .\scripts\atajo.ps1 -Repos "C:\Users\yo\proyectos"   # o donde tengas tus proyectos
#   .\scripts\atajo.ps1 -Nombre "Subir a GitHub"         # otro nombre para el acceso
#
# El atajo abre dist\apusw.exe: la ventana sola, sin terminal, y apus se apaga
# cuando la cerrás. Compilá antes con .\scripts\build.ps1.

param(
	[string]$Repos  = [Environment]::GetFolderPath("Desktop"),
	[string]$Nombre = "apus"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root "dist\apusw.exe"
$ico  = Join-Path $root "assets\apus.ico"

if (-not (Test-Path $exe)) {
	throw "no encuentro $exe — compilalo primero con: .\scripts\build.ps1"
}
if (-not (Test-Path $Repos)) {
	throw "la carpeta no existe: $Repos"
}

$destino = Join-Path ([Environment]::GetFolderPath("Desktop")) "$Nombre.lnk"
$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($destino)
$lnk.TargetPath       = $exe
$lnk.Arguments        = "ui --dir `"$Repos`""
$lnk.WorkingDirectory = $root
$lnk.WindowStyle      = 1
$lnk.Description      = "apus: subir una carpeta a su repo"
if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
$lnk.Save()

Write-Host "atajo listo: $destino"
