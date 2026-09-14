import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AUTO_TRAILER, autoMessage, parseFlight } from '../../src/core/apus';
import { browseUrl, parseAutoCommits, parseLastPush } from '../../src/core/git';

// Salidas reales de apus 2.1.0 (stderr, sin terminal).

test('parseFlight: subida completa', () => {
  const f = parseFlight(0, [
    '» git add -A',
    '» git commit -m chore: auto 1',
    '[main 5951cd8] chore: auto 1',
    '» git push',
    '   5951cd8..cb60c48  main -> main',
    '✔ main → origin/main',
    '  https://github.com/u/r',
    '',
  ].join('\n'));
  assert.equal(f.ok, true);
  assert.equal(f.summary, 'main → origin/main');
  assert.equal(f.detail, 'https://github.com/u/r');
  assert.equal(f.committed, true);
  assert.equal(f.pushed, true);
});

test('parseFlight: nada que hacer', () => {
  const f = parseFlight(0, '✔ nada que hacer: árbol limpio y main al día con origin/main\n');
  assert.equal(f.ok, true);
  assert.equal(f.committed, false);
  assert.equal(f.pushed, false);
  assert.equal(f.detail, undefined);
});

test('parseFlight: falla el push con el commit ya hecho', () => {
  const f = parseFlight(3, [
    '» git add -A',
    '» git commit -m x',
    '» git push',
    '! [rejected]        main -> main (fetch first)',
    '✖ el push falló: main → origin/main',
    "  el remoto tiene commits que vos no tenés: corré 'git pull --rebase' y volvé a intentar",
  ].join('\r\n'));
  assert.equal(f.ok, false);
  assert.equal(f.summary, 'el push falló: main → origin/main');
  assert.match(f.detail ?? '', /git pull --rebase/);
  assert.equal(f.committed, true);
  assert.equal(f.pushed, false);
});

test('parseFlight: sin línea de resumen', () => {
  assert.equal(parseFlight(1, 'algo raro\n').summary, 'algo raro');
  // Sin nada que mostrar, la interfaz explica el código en su idioma.
  assert.equal(parseFlight(-1, 'a medias').summary, undefined);
  assert.equal(parseFlight(2, '').summary, undefined);
});

test('parseFlight: ignora colores', () => {
  const f = parseFlight(0, '\x1b[32m✔\x1b[0m main → origin/main\n');
  assert.equal(f.summary, 'main → origin/main');
});

test('autoMessage agrega el trailer en su propio párrafo', () => {
  const msg = autoMessage('wip {date}', new Date(2026, 8, 14, 9, 5));
  assert.equal(msg, `wip 2026-09-14 09:05\n\n${AUTO_TRAILER}`);
  assert.match(autoMessage('  ', new Date()), /^chore: auto-commit /);
});

test('parseAutoCommits', () => {
  const out = 'aaaa\x1faa\x1f1789400902\x1fchore: auto 1\x1e\nbbbb\x1fbb\x1f1789400800\x1fcon | raros\x1e\n';
  assert.deepEqual(parseAutoCommits(out), [
    { hash: 'aaaa', short: 'aa', at: 1789400902000, subject: 'chore: auto 1' },
    { hash: 'bbbb', short: 'bb', at: 1789400800000, subject: 'con | raros' },
  ]);
  assert.deepEqual(parseAutoCommits(''), []);
});

test('parseLastPush toma el push más reciente y saltea los fetch', () => {
  const out = [
    'origin/main@{1789400999}\tfetch: fast-forward',
    'origin/main@{1789400903}\tupdate by push',
    'origin/main@{1789400902}\tupdate by push',
  ].join('\n');
  assert.equal(parseLastPush(out), 1789400903000);
  assert.equal(parseLastPush('origin/main@{1}\tfetch: fast-forward'), undefined);
});

test('browseUrl', () => {
  assert.equal(browseUrl('git@github.com:u/r.git'), 'https://github.com/u/r');
  assert.equal(browseUrl('ssh://git@github.com/u/r.git'), 'https://github.com/u/r');
  assert.equal(browseUrl('https://github.com/u/r.git'), 'https://github.com/u/r');
  assert.equal(browseUrl('../remote.git'), undefined);
  assert.equal(browseUrl('C:\\repos\\r'), undefined);
});
