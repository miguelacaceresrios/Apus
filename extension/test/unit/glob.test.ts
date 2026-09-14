import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compileGlobs, globToRegExp } from '../../src/core/glob';

const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

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
});

test('nombrar una carpeta cubre lo que tiene adentro', () => {
  assert.ok(matches('node_modules', 'node_modules/x/index.js'));
  assert.ok(matches('dist/', 'dist/extension.js'));
  assert.ok(!matches('dist', 'distance.txt'));
});

test('? y llaves', () => {
  assert.ok(matches('file?.txt', 'file1.txt'));
  assert.ok(!matches('file?.txt', 'file10.txt'));
  assert.ok(matches('*.{png,jpg}', 'img/a.jpg'));
  assert.ok(!matches('*.{png,jpg}', 'img/a.gif'));
});

test('los caracteres de regex se toman literales', () => {
  assert.ok(matches('a+b(1).txt', 'a+b(1).txt'));
  assert.ok(!matches('a.txt', 'abtxt'));
});

test('compileGlobs acepta rutas de Windows e informa los patrones rotos', () => {
  const bad: string[] = [];
  const ignored = compileGlobs(['*.log', '{roto', '  '], (p) => bad.push(p));
  assert.deepEqual(bad, ['{roto']);
  assert.ok(ignored('logs\\debug.log'));
  assert.ok(!ignored('src\\main.ts'));
});
