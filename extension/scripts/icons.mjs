// Genera los íconos de la extensión desde la misma figura que usa apus
// (tools/icongen en el repo de apus, viewBox 24x24):
//
//   images/activity.svg     barra de actividad
//   images/apus-icons.woff  fuente con $(apus-logo), para la barra de estado
//
//   node scripts/icons.mjs
//
// Si cambia la figura en apus, copiá acá los puntos de `half`.

import { writeFileSync } from 'node:fs';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';

/** Media marca: tres cúbicas. La otra mitad sale por espejo. */
const half = [
  [
    [12, 2.8],
    [9.8, 5.6],
    [6.4, 9.6],
    [1.4, 14.6],
  ],
  [
    [1.4, 14.6],
    [2.6, 15.4],
    [3.4, 16.2],
    [4.6, 17.4],
  ],
  [
    [4.6, 17.4],
    [7.4, 14.6],
    [9.6, 12.4],
    [12, 10.4],
  ],
];
const mirror = ([x, y]) => [24 - x, y];
const segments = [...half, ...[...half].reverse().map((s) => [...s].reverse().map(mirror))];

const xs = segments.flat().map((p) => p[0]);
const ys = segments.flat().map((p) => p[1]);
const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };

/**
 * Path de la figura escalada para que su ancho sea `width`, centrada en
 * (cx, cy). Con `flipY`, el eje y crece hacia arriba, como en las fuentes.
 */
function path({ width, cx, cy, flipY = false }) {
  const scale = width / (box.maxX - box.minX);
  const midX = (box.minX + box.maxX) / 2;
  const midY = (box.minY + box.maxY) / 2;
  const at = ([x, y]) => {
    const px = cx + (x - midX) * scale;
    const py = flipY ? cy - (y - midY) * scale : cy + (y - midY) * scale;
    return `${round(px)} ${round(py)}`;
  };
  const [first] = segments;
  let d = `M${at(first[0])}`;
  for (const [, c1, c2, end] of segments) {
    d += `C${at(c1)} ${at(c2)} ${at(end)}`;
  }
  return d + 'Z';
}

const round = (n) => Number(n.toFixed(2));

// Barra de actividad: 24x24 con 2 de margen, como los codicons.
writeFileSync(
  'images/activity.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="${path({ width: 20, cx: 12, cy: 12 })}"/></svg>\n`,
);

// Fuente: em de 1000 con la línea base abajo, así el glifo llena el cuadro de
// 16px igual que un codicon.
const EM = 1000;
const svgFont = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg">
<defs>
<font id="apus-icons" horiz-adv-x="${EM}">
<font-face font-family="apus-icons" units-per-em="${EM}" ascent="${EM}" descent="0"/>
<missing-glyph horiz-adv-x="0"/>
<glyph glyph-name="apus-logo" unicode="&#xE001;" horiz-adv-x="${EM}" d="${path({ width: 820, cx: EM / 2, cy: EM / 2, flipY: true })}"/>
</font>
</defs>
</svg>
`;
const ttf = svg2ttf(svgFont, { description: 'apus icons', version: '1.0' });
writeFileSync('images/apus-icons.woff', Buffer.from(ttf2woff(new Uint8Array(ttf.buffer))));

console.log('images/activity.svg\nimages/apus-icons.woff');
