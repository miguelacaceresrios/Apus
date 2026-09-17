import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compileGlob, compileGlobs } from '../../src/core/glob';

const matches = (glob: string, path: string) => compileGlob(glob)(path);

test('un patrón sin "/" vale a cualquier profundidad', () => {
  assert.ok(matches('*.log', 'debug.log'));
  assert.ok(matches('*.log', 'logs/2026/debug.log'));
  assert.ok(!matches('*.log', 'debug.log.txt'));
});

test('un patrón con "/" se ancla a la raíz del repo', () => {
  assert.ok(matches('docs/*.md', 'docs/a.md'));
  assert.ok(!matches('docs/*.md', 'src/docs/a.md'));
  assert.ok(!matches('docs/*.md', 'docs/sub/a.md'));
  assert.ok(matches('/build', 'build/out.js'));
});

test('** cruza carpetas, incluso ninguna', () => {
  assert.ok(matches('docs/**/*.md', 'docs/a.md'));
  assert.ok(matches('docs/**/*.md', 'docs/x/y/a.md'));
  assert.ok(matches('docs/**', 'docs/x/y/a.md'));
  assert.ok(matches('**/test/**/*.snap', 'a/b/test/c/d.snap'));
  assert.ok(!matches('**/test/**/*.snap', 'a/b/tests/c/d.snap'));
});

test('nombrar una carpeta cubre lo que tiene adentro', () => {
  assert.ok(matches('node_modules', 'node_modules/x/index.js'));
  assert.ok(matches('dist/', 'dist/extension.js'));
  assert.ok(!matches('dist', 'distance.txt'));
});

test('? y llaves, también anidadas', () => {
  assert.ok(matches('file?.txt', 'file1.txt'));
  assert.ok(!matches('file?.txt', 'file10.txt'));
  assert.ok(matches('*.{png,jpg}', 'img/a.jpg'));
  assert.ok(!matches('*.{png,jpg}', 'img/a.gif'));
  assert.ok(matches('{docs,src/{a,b}}/*.md', 'src/b/x.md'));
  assert.ok(!matches('{docs,src/{a,b}}/*.md', 'src/c/x.md'));
});

test('los caracteres especiales se toman literales', () => {
  assert.ok(matches('a+b(1).txt', 'a+b(1).txt'));
  assert.ok(!matches('a.txt', 'abtxt'));
  assert.ok(matches('[x]$^.txt', '[x]$^.txt'));
});

test('compileGlobs acepta rutas de Windows e informa los patrones rotos', () => {
  const bad: string[] = [];
  const ignored = compileGlobs(['*.log', '{roto', '  ', 'x'.repeat(1001), '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}'], (p) => bad.push(p));
  assert.equal(bad.length, 3);
  assert.equal(bad[0], '{roto');
  assert.ok(ignored('logs\\debug.log'));
  assert.ok(!ignored('src\\main.ts'));
});

test('un patrón armado para colgar la extensión termina enseguida', () => {
  // Con la versión en regex esto tardaba más de dos minutos.
  const hostile = ['**/**/**/**/**/**/**/**/**/**/**/**/x', '**/a/**/a/**/a/**/a/**/a/**/a/**/a/**/b', '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b'];
  const long = `${'a/'.repeat(200)}y`;
  const longName = 'a'.repeat(5000);
  const started = Date.now();
  for (const glob of hostile) {
    assert.equal(matches(glob, long), false);
    assert.equal(matches(glob, longName), false);
  }
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});
