// icongen genera los íconos de apus y de Aerodramus a partir de assets/apus.svg,
// el logo, sobre un cuadrado de esquinas redondeadas (ver style). Lo rasteriza a mano, sin
// dependencias: entiende lo que usa el logo (trazos con M, L, H, V, C, Q y Z, y
// rellenos de color o de degradé lineal).
//
//	go run ./tools/icongen                          # assets/{apus,aerodramus}.{ico,png}
//	go run ./tools/icongen sheet x.png [aerodramus] # hoja con los tamaños chicos ampliados
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

const logoPath = "assets/apus.svg"

type pt struct{ x, y float64 }

// ─── lectura del SVG ────────────────────────────────────────────────────────

type stop struct {
	off float64
	rgb [3]float64
}

type gradient struct {
	a, b  pt
	stops []stop
}

type shape struct {
	polys [][]pt // un polígono por subtrazo, ya aplanado
	solid [3]float64
	grad  *gradient
}

type logo struct {
	box    [4]float64 // viewBox: x, y, ancho, alto
	shapes []shape
}

func (s *shape) colorAt(p pt) [3]float64 {
	g := s.grad
	if g == nil {
		return s.solid
	}
	dx, dy := g.b.x-g.a.x, g.b.y-g.a.y
	t := ((p.x-g.a.x)*dx + (p.y-g.a.y)*dy) / (dx*dx + dy*dy)
	st := g.stops
	if t <= st[0].off {
		return st[0].rgb
	}
	for i := 1; i < len(st); i++ {
		if t <= st[i].off {
			k := (t - st[i-1].off) / (st[i].off - st[i-1].off)
			return mix(st[i-1].rgb, st[i].rgb, k)
		}
	}
	return st[len(st)-1].rgb
}

func attr(se xml.StartElement, name string) string {
	for _, a := range se.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func num(s string) float64 {
	s = strings.TrimSpace(s)
	pct := strings.HasSuffix(s, "%")
	v, _ := strconv.ParseFloat(strings.TrimSuffix(s, "%"), 64)
	if pct {
		v /= 100
	}
	return v
}

// parseColor entiende rgb(r,g,b) y #rrggbb, que es lo que trae el logo.
func parseColor(s string) ([3]float64, error) {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "rgb(") && strings.HasSuffix(s, ")") {
		parts := strings.Split(s[4:len(s)-1], ",")
		if len(parts) == 3 {
			return [3]float64{num(parts[0]), num(parts[1]), num(parts[2])}, nil
		}
	}
	if strings.HasPrefix(s, "#") && len(s) == 7 {
		v, err := strconv.ParseUint(s[1:], 16, 32)
		if err == nil {
			return [3]float64{float64(v >> 16), float64(v >> 8 & 0xff), float64(v & 0xff)}, nil
		}
	}
	return [3]float64{}, fmt.Errorf("color que no entiendo: %q", s)
}

func readLogo(path string) (*logo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lg := &logo{}
	grads := map[string]*gradient{}
	type pending struct {
		d, fill string
	}
	var paths []pending
	var cur *gradient

	dec := xml.NewDecoder(bytes.NewReader(data))
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "svg":
				f := strings.Fields(strings.ReplaceAll(attr(t, "viewBox"), ",", " "))
				if len(f) != 4 {
					return nil, fmt.Errorf("%s: falta el viewBox", path)
				}
				for i := range f {
					lg.box[i] = num(f[i])
				}
			case "linearGradient":
				if u := attr(t, "gradientUnits"); u != "userSpaceOnUse" {
					return nil, fmt.Errorf("%s: degradé %q en %q, solo entiendo userSpaceOnUse", path, attr(t, "id"), u)
				}
				cur = &gradient{
					a: pt{num(attr(t, "x1")), num(attr(t, "y1"))},
					b: pt{num(attr(t, "x2")), num(attr(t, "y2"))},
				}
				grads[attr(t, "id")] = cur
			case "stop":
				if cur == nil {
					continue
				}
				c, err := parseColor(attr(t, "stop-color"))
				if err != nil {
					return nil, err
				}
				cur.stops = append(cur.stops, stop{num(attr(t, "offset")), c})
			case "path":
				if tr := attr(t, "transform"); tr != "" && tr != "translate(0,0)" {
					return nil, fmt.Errorf("%s: transform %q, no lo entiendo", path, tr)
				}
				paths = append(paths, pending{attr(t, "d"), attr(t, "fill")})
			}
		case xml.EndElement:
			if t.Name.Local == "linearGradient" {
				cur = nil
			}
		}
	}

	for _, p := range paths {
		polys, err := parsePath(p.d)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", path, err)
		}
		sh := shape{polys: polys}
		if strings.HasPrefix(p.fill, "url(#") {
			id := strings.TrimSuffix(strings.TrimPrefix(p.fill, "url(#"), ")")
			g := grads[id]
			if g == nil || len(g.stops) == 0 {
				return nil, fmt.Errorf("%s: no encuentro el degradé %q", path, id)
			}
			sh.grad = g
		} else if p.fill == "" || p.fill == "none" {
			continue
		} else {
			if sh.solid, err = parseColor(p.fill); err != nil {
				return nil, fmt.Errorf("%s: %v", path, err)
			}
		}
		lg.shapes = append(lg.shapes, sh)
	}
	if lg.box[2] == 0 || len(lg.shapes) == 0 {
		return nil, fmt.Errorf("%s: no encontré nada que dibujar", path)
	}
	return lg, nil
}

// parsePath aplana un atributo d a polígonos. Las curvas se cortan en tramos
// rectos, de sobra para el tamaño más grande del ícono.
func parsePath(d string) ([][]pt, error) {
	toks := tokenize(d)
	var polys [][]pt
	var poly []pt
	var cur, start pt
	cmd := byte(0)
	i := 0
	next := func() float64 {
		v, _ := strconv.ParseFloat(toks[i], 64)
		i++
		return v
	}
	hasNum := func(n int) bool {
		if i+n > len(toks) {
			return false
		}
		for _, t := range toks[i : i+n] {
			if isCmd(t) {
				return false
			}
		}
		return true
	}
	flush := func() {
		if len(poly) > 2 {
			polys = append(polys, poly)
		}
		poly = nil
	}
	const steps = 24
	for i < len(toks) {
		if isCmd(toks[i]) {
			cmd = toks[i][0]
			i++
		} else if cmd == 0 {
			return nil, fmt.Errorf("trazo que no empieza con un comando: %q", d[:min(len(d), 20)])
		}
		rel := cmd >= 'a'
		off := func(p pt) pt {
			if rel {
				return pt{p.x + cur.x, p.y + cur.y}
			}
			return p
		}
		switch cmd | 0x20 { // en minúscula
		case 'z':
			if len(poly) > 0 {
				flush()
			}
			cur = start
			continue
		case 'm':
			if !hasNum(2) {
				return nil, fmt.Errorf("faltan números después de %c", cmd)
			}
			flush()
			cur = off(pt{next(), next()})
			start = cur
			poly = []pt{cur}
			// los pares que siguen a un M son L
			if rel {
				cmd = 'l'
			} else {
				cmd = 'L'
			}
		case 'l':
			if !hasNum(2) {
				return nil, fmt.Errorf("faltan números después de %c", cmd)
			}
			cur = off(pt{next(), next()})
			poly = append(poly, cur)
		case 'h':
			if !hasNum(1) {
				return nil, fmt.Errorf("faltan números después de %c", cmd)
			}
			x := next()
			if rel {
				x += cur.x
			}
			cur = pt{x, cur.y}
			poly = append(poly, cur)
		case 'v':
			if !hasNum(1) {
				return nil, fmt.Errorf("faltan números después de %c", cmd)
			}
			y := next()
			if rel {
				y += cur.y
			}
			cur = pt{cur.x, y}
			poly = append(poly, cur)
		case 'c':
			if !hasNum(6) {
				return nil, fmt.Errorf("faltan números después de %c", cmd)
			}
			c1 := off(pt{next(), next()})
			c2 := off(pt{next(), next()})
			end := off(pt{next(), next()})
			for s := 1; s <= steps; s++ {
				poly = append(poly, cubic(cur, c1, c2, end, float64(s)/steps))
			}
			cur = end
		case 'q':
			if !hasNum(4) {
				return nil, fmt.Errorf("faltan números después de %c", cmd)
			}
			c := off(pt{next(), next()})
			end := off(pt{next(), next()})
			for s := 1; s <= steps; s++ {
				t := float64(s) / steps
				u := 1 - t
				poly = append(poly, pt{
					u*u*cur.x + 2*u*t*c.x + t*t*end.x,
					u*u*cur.y + 2*u*t*c.y + t*t*end.y,
				})
			}
			cur = end
		default:
			return nil, fmt.Errorf("comando de trazo que no entiendo: %c", cmd)
		}
	}
	flush()
	return polys, nil
}

func isCmd(t string) bool {
	return len(t) == 1 && strings.ContainsRune("MmLlHhVvCcQqZz", rune(t[0]))
}

// tokenize separa comandos y números: "M10-5.5.5" → M 10 -5.5 .5
func tokenize(d string) []string {
	var out []string
	var b strings.Builder
	emit := func() {
		if b.Len() > 0 {
			out = append(out, b.String())
			b.Reset()
		}
	}
	for i := 0; i < len(d); i++ {
		c := d[i]
		switch {
		case isCmd(string(c)):
			emit()
			out = append(out, string(c))
		case c == ' ' || c == ',' || c == '\n' || c == '\t' || c == '\r':
			emit()
		case c == '-' && b.Len() > 0 && !strings.HasSuffix(b.String(), "e"):
			emit()
			b.WriteByte(c)
		case c == '.' && strings.Contains(b.String(), "."):
			emit()
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	emit()
	return out
}

func cubic(p0, p1, p2, p3 pt, t float64) pt {
	u := 1 - t
	a, b, c, d := u*u*u, 3*u*u*t, 3*u*t*t, t*t*t
	return pt{
		a*p0.x + b*p1.x + c*p2.x + d*p3.x,
		a*p0.y + b*p1.y + c*p2.y + d*p3.y,
	}
}

// ─── rasterizado ────────────────────────────────────────────────────────────

// coverage rasteriza polígonos por scanline con la regla nonzero (la de SVG)
// en una grilla ss veces más fina, y devuelve la cobertura promediada: eso es
// el antialiasing.
func coverage(polys [][]pt, size, ss int) []float64 {
	hi := size * ss
	type cross struct {
		x   float64
		dir int
	}
	out := make([]float64, size*size)
	inv := 1.0 / float64(ss*ss)
	var xs []cross
	for y := 0; y < hi; y++ {
		yc := (float64(y) + 0.5) / float64(ss)
		xs = xs[:0]
		for _, poly := range polys {
			for i := range poly {
				a, b := poly[i], poly[(i+1)%len(poly)]
				switch {
				case a.y <= yc && b.y > yc:
					xs = append(xs, cross{a.x + (yc-a.y)/(b.y-a.y)*(b.x-a.x), 1})
				case b.y <= yc && a.y > yc:
					xs = append(xs, cross{a.x + (yc-a.y)/(b.y-a.y)*(b.x-a.x), -1})
				}
			}
		}
		if len(xs) == 0 {
			continue
		}
		sort.Slice(xs, func(i, j int) bool { return xs[i].x < xs[j].x })
		row := (y / ss) * size
		wind := 0
		for i := 0; i+1 < len(xs); i++ {
			wind += xs[i].dir
			if wind == 0 {
				continue
			}
			from := int(xs[i].x*float64(ss) + 0.5)
			to := int(xs[i+1].x*float64(ss) + 0.5)
			for x := max(0, from); x < min(hi, to); x++ {
				out[row+x/ss] += inv
			}
		}
	}
	return out
}

// roundedRect devuelve la cobertura del cuadrado, con las esquinas suavizadas.
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
					qx := math.Max(radius-px, px-(s-radius))
					qy := math.Max(radius-py, py-(s-radius))
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

func mix(a, b [3]float64, t float64) [3]float64 {
	return [3]float64{a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t}
}

// style es cómo va el ave sobre el cuadrado. apus: cuadrado crema, el ave a
// color y, en los tamaños chicos (la barra de tareas, la de título), como
// silueta oscura, porque los detalles del plumaje se empastan. Aerodramus, de
// la misma familia pero al revés: cuadrado café y el ave como silueta crema,
// siempre, para distinguirla de un vistazo.
type style struct {
	name                string
	tileTop, tileBottom [3]float64
	ink                 [3]float64
	silhouetteMax       int
}

var styles = []style{
	{name: "apus", tileTop: [3]float64{0xf6, 0xf3, 0xed}, tileBottom: [3]float64{0xe2, 0xda, 0xcd}, ink: [3]float64{0x2a, 0x23, 0x20}, silhouetteMax: 48},
	{name: "aerodramus", tileTop: [3]float64{0x3b, 0x33, 0x2d}, tileBottom: [3]float64{0x1f, 0x1b, 0x18}, ink: [3]float64{0xed, 0xe8, 0xdf}, silhouetteMax: 1 << 30},
}

func styleNamed(name string) (style, bool) {
	for _, st := range styles {
		if st.name == name {
			return st, true
		}
	}
	return style{}, false
}

// render dibuja el logo sobre el cuadrado, al tamaño pedido.
func render(lg *logo, size int, st style) *image.RGBA {
	ss := 4
	if size <= 48 {
		ss = 8
	} else if size >= 128 {
		ss = 2
	}
	box := roundedRect(size, 4, float64(size)*0.225)

	// del viewBox al píxel: el logo ocupa el cuadrado menos un margen, que en
	// los tamaños chicos se achica para que el ave no quede diminuta
	pad := float64(size) * 0.1
	if size <= 32 {
		pad = float64(size) * 0.04
	}
	scale := (float64(size) - 2*pad) / math.Max(lg.box[2], lg.box[3])
	offX := pad + ((float64(size)-2*pad)-lg.box[2]*scale)/2 - lg.box[0]*scale
	offY := pad + ((float64(size)-2*pad)-lg.box[3]*scale)/2 - lg.box[1]*scale

	px := make([][3]float64, size*size)
	for i := range px {
		x, y := float64(i%size), float64(i/size)
		px[i] = mix(st.tileTop, st.tileBottom, (x+y)/float64(2*size))
	}
	for _, sh := range lg.shapes {
		polys := make([][]pt, len(sh.polys))
		for j, poly := range sh.polys {
			polys[j] = make([]pt, len(poly))
			for k, p := range poly {
				polys[j][k] = pt{p.x*scale + offX, p.y*scale + offY}
			}
		}
		cov := coverage(polys, size, ss)
		for i, c := range cov {
			if c <= 0 {
				continue
			}
			v := pt{(float64(i%size) + 0.5 - offX) / scale, (float64(i/size) + 0.5 - offY) / scale}
			col := st.ink
			if size > st.silhouetteMax {
				col = sh.colorAt(v)
			}
			px[i] = mix(px[i], col, math.Min(1, c))
		}
	}

	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for i, b := range box {
		// alfa premultiplicado: el cuadrado manda
		img.Set(i%size, i/size, color.RGBA{
			uint8(px[i][0]*b + 0.5), uint8(px[i][1]*b + 0.5), uint8(px[i][2]*b + 0.5), uint8(b*255 + 0.5),
		})
	}
	return img
}

// hoja de contacto: cada tamaño real ampliado a lo bruto, para juzgar cómo
// quedan los píxeles en la barra de tareas y el escritorio.
func sheet(lg *logo, st style, path string) error {
	sizes := []int{16, 24, 32, 48, 128}
	zoom := []int{8, 6, 5, 4, 1}
	gap, pad := 16, 16
	w := pad
	for i := range sizes {
		w += sizes[i]*zoom[i] + gap
	}
	h := 192 + pad*2
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(out, out.Bounds(), &image.Uniform{color.RGBA{0x55, 0x55, 0x58, 0xff}}, image.Point{}, draw.Src)
	x := pad
	for i, sz := range sizes {
		src := render(lg, sz, st)
		z := zoom[i]
		for py := 0; py < sz*z; py++ {
			for px := 0; px < sz*z; px++ {
				out.Set(x+px, pad+py, src.At(px/z, py/z))
			}
		}
		x += sz*z + gap
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "icongen:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	lg, err := readLogo(logoPath)
	if err != nil {
		return err
	}
	// go run ./tools/icongen sheet x.png [aerodramus]
	if len(args) >= 2 && args[0] == "sheet" {
		st := styles[0]
		if len(args) == 3 {
			var ok bool
			if st, ok = styleNamed(args[2]); !ok {
				return fmt.Errorf("no conozco el estilo %q", args[2])
			}
		}
		if err := sheet(lg, st, args[1]); err != nil {
			return err
		}
		fmt.Println("hoja de contacto:", args[1])
		return nil
	}
	for _, st := range styles {
		if err := writeIcons(lg, st, "assets/"+st.name+".ico", "assets/"+st.name+".png"); err != nil {
			return err
		}
	}
	return nil
}

func writeIcons(lg *logo, st style, icoPath, pngPath string) error {
	sizes := []int{16, 24, 32, 48, 64, 128, 256}
	var pngs [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		if err := png.Encode(&buf, render(lg, s, st)); err != nil {
			return err
		}
		pngs = append(pngs, buf.Bytes())
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
		return err
	}
	fmt.Printf("%s (%d bytes)\n", icoPath, ico.Len())

	// Un PNG grande para Linux (.desktop) y el README.
	if err := os.WriteFile(pngPath, pngs[len(pngs)-1], 0o644); err != nil {
		return err
	}
	fmt.Printf("%s (%d bytes)\n", pngPath, len(pngs[len(pngs)-1]))
	return nil
}
