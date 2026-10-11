//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Instalar en Linux y macOS es: el binario en ~/.local/bin y, en Linux, los
// accesos de apus y de Aerodramus en el menú de aplicaciones, con sus íconos.
// Todo en la carpeta del usuario.

type installFiles struct {
	bin                  string
	desktop, aeroDesktop string
	icon, aeroIcon       string
}

func installPaths() (installFiles, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return installFiles{}, err
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(home, ".local", "share")
	}
	icons := filepath.Join(data, "icons", "hicolor", "256x256", "apps")
	return installFiles{
		bin:         filepath.Join(home, ".local", "bin", "apus"),
		desktop:     filepath.Join(data, "applications", "apus.desktop"),
		aeroDesktop: filepath.Join(data, "applications", "aerodramus.desktop"),
		icon:        filepath.Join(icons, "apus.png"),
		aeroIcon:    filepath.Join(icons, "aerodramus.png"),
	}, nil
}

const desktopEntry = `[Desktop Entry]
Type=Application
Name=apus
Comment=Tu carpeta a GitHub, en un paso
Exec="{bin}" ui --quit-on-close
Icon=apus
Terminal=false
Categories=Development;
`

const aeroDesktopEntry = `[Desktop Entry]
Type=Application
Name=Aerodramus
Comment=Los hallazgos de apus-guard, para revisarlos
Exec="{bin}" aerodramus --quit-on-close
Icon=aerodramus
Terminal=false
Categories=Development;
`

func cmdInstall(args []string) int {
	for _, a := range args {
		if a != "-q" && a != "--quiet" {
			return dieMsg(codeUsage, "opción desconocida: "+a, "uso: apus install")
		}
		quiet = true
	}
	paths, err := installPaths()
	if err != nil {
		return dieMsg(codeRepo, "no pude instalar apus: "+err.Error(), "")
	}
	bin := paths.bin
	self, err := os.Executable()
	if err == nil {
		self, err = filepath.EvalSymlinks(self)
	}
	if err != nil {
		return dieMsg(codeRepo, "no pude instalar apus: "+err.Error(), "")
	}

	step("instalando en " + bin)
	if !samePath(self, bin) {
		data, err := os.ReadFile(self)
		if err == nil {
			err = os.MkdirAll(filepath.Dir(bin), 0o755)
		}
		if err == nil {
			// Primero a un temporal y después el renombre: si apus está corriendo,
			// el binario viejo sigue entero hasta que termina.
			tmp := bin + ".new"
			if err = os.WriteFile(tmp, data, 0o755); err == nil {
				err = os.Rename(tmp, bin)
			}
		}
		if err != nil {
			return dieMsg(codeRepo, "no pude copiar apus: "+err.Error(), "")
		}
	}

	if runtime.GOOS == "linux" {
		for _, f := range []struct {
			path string
			data []byte
		}{
			{paths.icon, appIcon}, {paths.desktop, []byte(strings.ReplaceAll(desktopEntry, "{bin}", bin))},
			{paths.aeroIcon, aeroPNG}, {paths.aeroDesktop, []byte(strings.ReplaceAll(aeroDesktopEntry, "{bin}", bin))},
		} {
			err := os.MkdirAll(filepath.Dir(f.path), 0o755)
			if err == nil {
				err = os.WriteFile(f.path, f.data, 0o644)
			}
			if err != nil {
				warnMsg("no pude crear el acceso en el menú: " + err.Error())
				break
			}
		}
	}

	okMsg("apus " + version + " instalado")
	if !inPath(filepath.Dir(bin)) {
		warnMsg(filepath.Dir(bin) + " no está en tu PATH: agregalo para usar 'apus' en la terminal")
	}
	return codeOK
}

func inPath(dir string) bool {
	for _, p := range filepath.SplitList(os.Getenv("PATH")) {
		if p != "" && samePath(p, dir) {
			return true
		}
	}
	return false
}

func cmdUninstall(args []string) int {
	for _, a := range args {
		if a != "-y" && a != "--yes" {
			return dieMsg(codeUsage, "opción desconocida: "+a, "uso: apus uninstall")
		}
	}
	paths, err := installPaths()
	if err != nil {
		return dieMsg(codeRepo, "no pude desinstalar apus: "+err.Error(), "")
	}
	removed := false
	for _, p := range []string{paths.bin, paths.desktop, paths.icon, paths.aeroDesktop, paths.aeroIcon} {
		if os.Remove(p) == nil {
			removed = true
		}
	}
	if !removed {
		return dieMsg(codeRepo, "apus no está instalado en "+paths.bin, "")
	}
	okMsg("apus desinstalado")
	return codeOK
}

// offerInstall es cosa del binario de ventana de Windows.
func offerInstall() bool { return false }
