// Las traducciones tienen que cubrir todo lo que muestra la extensión. Si esto
// falla después de agregar un texto: npm run l10n, y traducí lo que falte.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(__dirname, '..', '..', '..');
const read = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, string>;
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort();

test('bundle.l10n.es.json traduce todos los textos, con los mismos {n}', () => {
  const source = read('l10n/bundle.l10n.json');
  const es = read('l10n/bundle.l10n.es.json');
  assert.deepEqual(
    Object.keys(source).filter((k) => !(k in es)),
    [],
    'faltan traducciones',
  );
  assert.deepEqual(
    Object.keys(es).filter((k) => !(k in source)),
    [],
    'sobran traducciones',
  );
  for (const [key, value] of Object.entries(es)) {
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
});

test('package.nls.es.json traduce todas las claves de package.nls.json', () => {
  const source = read('package.nls.json');
  const es = read('package.nls.es.json');
  assert.deepEqual(
    Object.keys(source).filter((k) => !(k in es)),
    [],
  );
  assert.deepEqual(
    Object.keys(es).filter((k) => !(k in source)),
    [],
  );
});

test('package.json solo usa claves que existen', () => {
  const pkg = readFileSync(join(root, 'package.json'), 'utf8');
  const nls = read('package.nls.json');
  const used = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]!);
  assert.ok(used.length > 0);
  assert.deepEqual(
    used.filter((k) => !(k in nls)),
    [],
  );
});
