#!/bin/sh
# Instala apus en Linux o macOS, en una línea:
#
#   curl -fsSL https://raw.githubusercontent.com/miguelacaceresrios/Apus/master/scripts/install.sh | sh
#
# Baja la última versión y corre 'apus install': queda en ~/.local/bin y, en
# Linux, en el menú de aplicaciones. Para sacarlo: apus uninstall.
set -eu

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) echo "apus: no hay binario para $(uname -m)" >&2; exit 1 ;;
esac
case $os in
	linux | darwin) ;;
	*) echo "apus: no hay binario para $os" >&2; exit 1 ;;
esac

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "Descargando apus ($os/$arch)..."
curl -fsSL -o "$tmp" "https://github.com/miguelacaceresrios/Apus/releases/latest/download/apus-$os-$arch"
chmod +x "$tmp"
# macOS marca lo descargado y Gatekeeper no lo deja abrir: se le saca la marca.
if [ "$os" = darwin ]; then
	xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
fi
"$tmp" install
