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

## icons: regenera assets/apus.ico y assets/apus.png
icons:
	$(GO) run ./tools/icongen

clean:
	rm -rf dist
