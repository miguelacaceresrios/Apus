# En Windows sin make, usá scripts/build.ps1: hace lo mismo.

GO      ?= go
LDFLAGS := -s -w

.PHONY: build windows linux test icons clean

## build: compila para esta máquina en dist/
build:
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o dist/ .

## windows: dist/apus.exe (terminal) y dist/apusw.exe (ventana, sin consola)
windows:
	GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o dist/apus.exe .
	GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS) -H=windowsgui" -o dist/apusw.exe .

## linux: dist/apus-linux-amd64
linux:
	GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o dist/apus-linux-amd64 .

## test: vet, pruebas de Go y las dos baterías de la terminal
test: build
	$(GO) vet ./...
	$(GO) test ./...
	scripts/test.sh
	APUS_IMPL=go scripts/test.sh

## icons: regenera assets/apus.ico y assets/apus.png desde assets/apus.svg, y el
## ícono y la versión de los .exe (rsrc_windows_*.syso; baja go-winres la primera vez)
icons:
	$(GO) run ./tools/icongen
	$(GO) run github.com/tc-hib/go-winres@v0.3.3 simply --icon assets/apus.ico --arch amd64,arm64 		--manifest gui --product-name apus --file-description "apus: tu carpeta a GitHub en un paso" 		--product-version git-tag --file-version git-tag --original-filename apus.exe --out rsrc

clean:
	rm -rf dist
