import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AUTO_TRAILER, autoMessage, parseFlight, parseJsonFlight, versionSpeaksJson } from '../../src/core/apus';
import { browseUrl, parseAutoCommits, parseChanges, parseLastPush, type ChangedFile } from '../../src/core/git';

// Salidas reales de apus 2.1.0 (stderr, sin terminal).

test('parseFlight: subida completa', () => {
  const f = parseFlight(
    0,
    [
      '» git add -A',
      '» git commit -m chore: auto 1',
      '[main 5951cd8] chore: auto 1',
      '» git push',
      '   5951cd8..cb60c48  main -> main',
      '✔ main → origin/main',
      '  https://github.com/u/r',
      '',
    ].join('\n'),
  );
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
  const f = parseFlight(
    3,
    [
      '» git add -A',
      '» git commit -m x',
      '» git push',
      '! [rejected]        main -> main (fetch first)',
      '✖ el push falló: main → origin/main',
      "  el remoto tiene commits que vos no tenés: corré 'git pull --rebase' y volvé a intentar",
    ].join('\r\n'),
  );
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
  // Sin la lista de archivos, {files} es la fecha: el asunto no queda cortado.
  assert.equal(autoMessage('  ', new Date(2026, 8, 14, 9, 5)), `chore: update 2026-09-14 09:05\n\n${AUTO_TRAILER}`);
});

test('autoMessage: los archivos en el asunto y en el cuerpo', () => {
  const files: ChangedFile[] = [
    { status: 'M', path: 'src/app.ts' },
    { status: 'A', path: 'README.md' },
    { status: 'D', path: 'docs/viejo.md' },
    { status: 'M', path: 'test/app.ts' },
    { status: 'A', path: 'lib/' },
  ];
  const date = new Date(2026, 8, 14, 9, 5);
  assert.equal(
    autoMessage('chore: update {files}', date, files),
    [
      'chore: update app.ts, README.md, viejo.md +1',
      'M src/app.ts\nA README.md\nD docs/viejo.md\nM test/app.ts\nA lib/',
      AUTO_TRAILER,
    ].join('\n\n'),
  );
  assert.match(autoMessage('{files}', date, files.slice(0, 1)), /^app\.ts\n\nM src\/app\.ts\n\n/);

  const many = Array.from({ length: 25 }, (_, i): ChangedFile => ({ status: 'A', path: `f${i}.txt` }));
  const body = autoMessage('x', date, many).split('\n\n')[1]!.split('\n');
  assert.equal(body.length, 21);
  assert.equal(body.at(-1), '… 5 more');
});

test('parseChanges: lo que va a commitear git add -A', () => {
  const out = [
    '?? nuevo.txt',
    ' M cambiado.ts',
    'M  preparado.ts',
    ' D borrado.txt',
    'D  borrado2.txt',
    'A  agregado.ts',
    'AM agregado2.ts',
    '?? inner/',
    '',
  ].join('\0');
  assert.deepEqual(parseChanges(out), [
    { status: 'A', path: 'nuevo.txt' },
    { status: 'M', path: 'cambiado.ts' },
    { status: 'M', path: 'preparado.ts' },
    { status: 'D', path: 'borrado.txt' },
    { status: 'D', path: 'borrado2.txt' },
    { status: 'A', path: 'agregado.ts' },
    { status: 'A', path: 'agregado2.ts' },
    { status: 'A', path: 'inner/' },
  ]);
  assert.deepEqual(parseChanges(''), []);
});

test('versionSpeaksJson: apus entiende --json desde la 2.2.0', () => {
  assert.equal(versionSpeaksJson('apus 2.2.0\n'), true);
  assert.equal(versionSpeaksJson('apus 2.10.1'), true);
  assert.equal(versionSpeaksJson('apus 3.0.0'), true);
  assert.equal(versionSpeaksJson('apus 2.1.0'), false);
  assert.equal(versionSpeaksJson('apus 1.9.9'), false);
  assert.equal(versionSpeaksJson('otra cosa'), false);
});

// Salidas reales de apus 2.2.0 con --json.

test('parseJsonFlight: subida completa', () => {
  const stdout =
    '{"apus":"2.2.0","ok":true,"code":0,"summary":"main → origin/main","committed":true,"pushed":true,"commit":"a1b2c3d","branch":"main","target":"origin/main","url":"https://github.com/u/r","steps":[{"cmd":"git add -A"}]}\n';
  const f = parseJsonFlight(0, stdout, '» git add -A\n» git commit -m x\n» git push\n✔ main → origin/main\n')!;
  assert.deepEqual(
    { ...f, output: undefined },
    {
      code: 0,
      ok: true,
      summary: 'main → origin/main',
      detail: 'https://github.com/u/r',
      committed: true,
      pushed: true,
      reason: undefined,
      output: undefined,
    },
  );
  // El registro es lo que apus escribió en stderr, no el JSON.
  assert.match(f.output, /^» git add -A/);
});

test('parseJsonFlight: falla sin conexión, con la pista y sin tokens', () => {
  const stdout = JSON.stringify({
    apus: '2.2.0',
    ok: false,
    code: 3,
    reason: 'offline',
    summary: 'el push falló: main → origin/main',
    hint: ['sin conexión con ', 'https://u:', 'secreto1234', '@github.com'].join(''),
    committed: true,
    pushed: false,
  });
  const f = parseJsonFlight(3, stdout, '')!;
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'offline');
  assert.equal(f.committed, true);
  assert.equal(f.detail, 'sin conexión con https://***@github.com');
});

test('parseJsonFlight: sin JSON, o si apus se pasó del tiempo', () => {
  assert.equal(parseJsonFlight(0, '', '✔ main → origin/main'), undefined);
  assert.equal(parseJsonFlight(1, '{roto', ''), undefined);
  assert.equal(parseJsonFlight(1, '{"code":1}', ''), undefined);
  // El JSON dice que salió bien, pero el proceso terminó por el timeout.
  assert.equal(parseJsonFlight(-1, '{"ok":true,"code":0}', '')?.ok, false);
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
