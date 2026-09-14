// icongen genera los íconos de apus desde la misma figura que usa la interfaz,
// rasterizada a mano (sin dependencias) sobre un cuadrado redondeado.
//
//	go run ./tools/icongen              # escribe assets/apus.ico y assets/apus.png
//	go run ./tools/icongen sheet x.png  # hoja con los tamaños chicos ampliados
//
// Si cambiás la figura, cambiá también el <path> de ui/index.html.
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"sort"
)

type pt struct{ x, y float64 }

// Media marca (viewBox 24x24): un chevrón macizo, sin partes finas, para que se
// lea entero a 16px. La otra mitad sale por espejo, así queda simétrico.
var half = [][4]pt{
	{{12, 2.8}, {9.8, 5.6}, {6.4, 9.6}, {1.4, 14.6}},     // borde superior del ala
	{{1.4, 14.6}, {2.6, 15.4}, {3.4, 16.2}, {4.6, 17.4}}, // punta, redondeada
	{{4.6, 17.4}, {7.4, 14.6}, {9.6, 12.4}, {12, 10.4}},  // borde inferior, al centro
}

// segs es el contorno completo: la mitad, y la misma mitad espejada y al revés.
var segs = func() [][4]pt {
	out := append([][4]pt{}, half...)
	for i := len(half) - 1; i >= 0; i-- {
		s := half[i]
		out = append(out, [4]pt{mirror(s[3]), mirror(s[2]), mirror(s[1]), mirror(s[0])})
	}
	return out
}()

func mirror(p pt) pt { return pt{24 - p.x, p.y} }

func cubic(s [4]pt, t float64) pt {
	u := 1 - t
	a, b, c, d := u*u*u, 3*u*u*t, 3*u*t*t, t*t*t
	return pt{
		a*s[0].x + b*s[1].x + c*s[2].x + d*s[3].x,
		a*s[0].y + b*s[1].y + c*s[2].y + d*s[3].y,
	}
}

// polygon aplana las cúbicas a segmentos rectos y encaja el dibujo en el lienzo,
// centrado y con el margen pedido. Así el contorno se puede editar sin recalcular
// escalas a mano.
func polygon(size int, pad float64) []pt {
	const steps = 48
	var poly []pt
	for _, s := range segs {
		for i := 1; i <= steps; i++ {
			poly = append(poly, cubic(s, float64(i)/steps))
		}
	}
	minX, minY := poly[0].x, poly[0].y
	maxX, maxY := minX, minY
	for _, p := range poly {
		minX, maxX = min64(minX, p.x), max64(maxX, p.x)
		minY, maxY = min64(minY, p.y), max64(maxY, p.y)
	}
	box := float64(size) - 2*pad
	scale := min64(box/(maxX-minX), box/(maxY-minY))
	offX := pad + (box-(maxX-minX)*scale)/2
	offY := pad + (box-(maxY-minY)*scale)/2
	for i, p := range poly {
		poly[i] = pt{(p.x-minX)*scale + offX, (p.y-minY)*scale + offY}
	}
	return poly
}

func min64(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// coverage rasteriza el polígono por scanline (par-impar) en una grilla grande y
// devuelve la cobertura promediada: eso es el antialiasing.
func coverage(poly []pt, size, ss int) []float64 {
	hi := size * ss
	// el polígono viene en coordenadas de la imagen final: lo llevamos a la grilla
	hiPoly := make([]pt, len(poly))
	for i, p := range poly {
		hiPoly[i] = pt{p.x * float64(ss), p.y * float64(ss)}
	}
	hits := make([]bool, hi*hi)
	var xs []float64
	for y := 0; y < hi; y++ {
		yc := float64(y) + 0.5
		xs = xs[:0]
		for i := range hiPoly {
			a, b := hiPoly[i], hiPoly[(i+1)%len(hiPoly)]
			if (a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc) {
				xs = append(xs, a.x+(yc-a.y)/(b.y-a.y)*(b.x-a.x))
			}
		}
		sort.Float64s(xs)
		for i := 0; i+1 < len(xs); i += 2 {
			from, to := int(xs[i]+0.5), int(xs[i+1]+0.5)
			for x := max(0, from); x < min(hi, to); x++ {
				hits[y*hi+x] = true
			}
		}
	}
	out := make([]float64, size*size)
	inv := 1.0 / float64(ss*ss)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			n := 0
			for dy := 0; dy < ss; dy++ {
				row := (y*ss + dy) * hi
				for dx := 0; dx < ss; dx++ {
					if hits[row+x*ss+dx] {
						n++
					}
				}
			}
			out[y*size+x] = float64(n) * inv
		}
	}
	return out
}

// roundedRect devuelve la cobertura del fondo, con las esquinas suavizadas.
func roundedRect(size, ss int, radius float64) []float64 {
	out := make([]float64, size*size)
	inv := 1.0 / float64(ss*ss)
	s := float64(size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			n := 0
			for dy := 0; dy < ss; dy++ {
				for dx := 0; dx < ss; dx++ {
					px := float64(x) + (float64(dx)+0.5)/float64(ss)
					py := float64(y) + (float64(dy)+0.5)/float64(ss)
					qx := max64(radius-px, px-(s-radius))
					qy := max64(radius-py, py-(s-radius))
					if qx <= 0 || qy <= 0 || qx*qx+qy*qy <= radius*radius {
						n++
					}
				}
			}
			out[y*size+x] = float64(n) * inv
		}
	}
	return out
}

func max64(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

var (
	bg   = color.RGBA{0x1b, 0x1a, 0x1f, 0xff} // carbón, igual que el tema oscuro
	bird = color.RGBA{0xef, 0x8a, 0x4b, 0xff} // ámbar de acento
)

func render(size int) *image.RGBA {
	ss := 4
	if size >= 128 {
		ss = 3
	}
	box := roundedRect(size, ss, float64(size)*0.225)
	mark := coverage(polygon(size, float64(size)*0.17), size, ss)

	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for i := range box {
		b, m := box[i], mark[i]*box[i]
		// el pájaro va encima del fondo; el alfa lo manda el cuadrado
		r := float64(bg.R)*(1-m) + float64(bird.R)*m
		g := float64(bg.G)*(1-m) + float64(bird.G)*m
		bl := float64(bg.B)*(1-m) + float64(bird.B)*m
		img.Set(i%size, i/size, color.RGBA{
			uint8(r*b + 0.5), uint8(g*b + 0.5), uint8(bl*b + 0.5), uint8(b*255 + 0.5),
		})
	}
	return img
}

// hoja de contacto: cada tamaño real ampliado a lo bruto, para juzgar cómo
// quedan los píxeles en la barra de tareas y el escritorio.
func sheet(path string) {
	sizes := []int{16, 24, 32, 48}
	zoom := []int{8, 6, 5, 4}
	gap, pad := 16, 16
	w := pad
	for i := range sizes {
		w += sizes[i]*zoom[i] + gap
	}
	h := 48*4 + pad*2
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(out, out.Bounds(), &image.Uniform{color.RGBA{0x55, 0x55, 0x58, 0xff}}, image.Point{}, draw.Src)
	x := pad
	for i, sz := range sizes {
		src := render(sz)
		z := zoom[i]
		for py := 0; py < sz*z; py++ {
			for px := 0; px < sz*z; px++ {
				out.Set(x+px, pad+py, src.At(px/z, py/z))
			}
		}
		x += sz*z + gap
	}
	f, err := os.Create(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	png.Encode(f, out)
	fmt.Println("hoja de contacto:", path)
}

func main() {
	if len(os.Args) > 2 && os.Args[1] == "sheet" {
		sheet(os.Args[2])
		return
	}
	icoPath, pngPath := "assets/apus.ico", "assets/apus.png"
	if len(os.Args) > 2 {
		icoPath, pngPath = os.Args[1], os.Args[2]
	}
	sizes := []int{16, 24, 32, 48, 64, 128, 256}
	var pngs [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		if err := png.Encode(&buf, render(s)); err != nil {
			panic(err)
		}
		pngs = append(pngs, buf.Bytes())
		fmt.Printf("  %3dpx → %6d bytes\n", s, buf.Len())
	}

	// contenedor ICO: cabecera + una entrada por tamaño + los PNG pegados atrás
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, uint16(0))
	binary.Write(&ico, binary.LittleEndian, uint16(1))
	binary.Write(&ico, binary.LittleEndian, uint16(len(sizes)))
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		dim := byte(s)
		if s == 256 {
			dim = 0
		}
		ico.Write([]byte{dim, dim, 0, 0})
		binary.Write(&ico, binary.LittleEndian, uint16(1))
		binary.Write(&ico, binary.LittleEndian, uint16(32))
		binary.Write(&ico, binary.LittleEndian, uint32(len(pngs[i])))
		binary.Write(&ico, binary.LittleEndian, uint32(offset))
		offset += len(pngs[i])
	}
	for _, p := range pngs {
		ico.Write(p)
	}
	if err := os.WriteFile(icoPath, ico.Bytes(), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "icongen:", err)
		os.Exit(1)
	}
	fmt.Printf("%s (%d bytes)\n", icoPath, ico.Len())

	// Un PNG grande para Linux (.desktop) y para el README.
	var buf bytes.Buffer
	if err := png.Encode(&buf, render(256)); err == nil {
		if err := os.WriteFile(pngPath, buf.Bytes(), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "icongen:", err)
			os.Exit(1)
		}
		fmt.Printf("%s (%d bytes)\n", pngPath, buf.Len())
	}
}
