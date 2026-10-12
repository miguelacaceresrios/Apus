// VS Code muestra los SVG de la guía dentro de una página con
// "style-src 'nonce-…'": un <style>, un class o un style="" dentro del SVG se
// ignoran, y todo queda con el relleno por defecto, que es negro. Los colores
// van como atributos (fill="var(--vscode-…, #fallback)").

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const media = join(__dirname, '..', '..', '..', 'media', 'walkthrough');

test('los SVG de la guía no dependen de CSS', () => {
  const files = readdirSync(media).filter((f) => f.endsWith('.svg'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const svg = readFileSync(join(media, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(svg, /<style/i, `${file}: <style>`);
    assert.doesNotMatch(svg, /\sclass=/i, `${file}: class=`);
    assert.doesNotMatch(svg, /\sstyle=/i, `${file}: style=`);
    // Cada var() de tema necesita un color de respaldo.
    for (const m of svg.matchAll(/var\((--vscode-[\w-]+)([^)]*)\)/g)) {
      assert.match(m[2]!, /^,\s*\S/, `${file}: ${m[1]} sin respaldo`);
    }
  }
});
