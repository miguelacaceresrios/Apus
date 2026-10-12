import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diagnose, flightEnv, parseFlight, parseJsonFlight } from '../../src/core/apus';
import { browseUrl, parseRemotes } from '../../src/core/git';
import { checkRemoteUrl, chooseRemote, redactCredentials, shortUrl } from '../../src/core/remote';

test('checkRemoteUrl acepta lo que entiende git', () => {
  for (const url of [
    'https://github.com/u/r.git',
    'http://gitea.local/u/r',
    'ssh://git@github.com/u/r.git',
    'git@github.com:u/r.git',
    'git@host:/srv/r.git',
    'file:///C:/repos/r',
    'C:\\repos\\r',
    '/srv/git/r.git',
  ]) {
    assert.deepEqual(checkRemoteUrl(`  ${url} `), { ok: true, url }, url);
  }
});

test('checkRemoteUrl explica lo que no sirve', () => {
  assert.deepEqual(checkRemoteUrl('   '), { ok: false, problem: 'empty' });
  assert.deepEqual(checkRemoteUrl('github.com/u/r'), { ok: false, problem: 'invalid', suggestion: 'https://github.com/u/r' });
  assert.deepEqual(checkRemoteUrl('mi repo'), { ok: false, problem: 'invalid' });
  assert.deepEqual(checkRemoteUrl('-c core.sshCommand=x'), { ok: false, problem: 'invalid' });
  assert.deepEqual(checkRemoteUrl('viper'), { ok: false, problem: 'invalid' });
});

test('chooseRemote elige como apus', () => {
  assert.equal(chooseRemote(['origin', 'fork'], 'fork'), 'fork');
  assert.equal(chooseRemote(['fork', 'origin'], undefined), 'origin');
  assert.equal(chooseRemote(['upstream'], undefined), 'upstream');
  assert.equal(chooseRemote(['a', 'b'], undefined), undefined);
  assert.equal(chooseRemote([], undefined), undefined);
  assert.equal(chooseRemote(['origin'], 'borrado'), 'origin');
});

// Armadas por partes: este archivo no tiene ninguna URL con clave escrita.
const token = ['gh', 'p_', 'A1b2'.repeat(9)].join('');
const withPassword = `https://u:${token}@github.com/u/r.git`;

test('shortUrl nunca muestra credenciales', () => {
  assert.equal(shortUrl('https://github.com/u/r.git'), 'github.com/u/r');
  assert.equal(shortUrl(withPassword), 'github.com/u/r');
  assert.equal(shortUrl('git@github.com:u/r.git'), 'github.com/u/r');
  assert.equal(shortUrl('ssh://git@github.com/u/r.git/'), 'github.com/u/r');
  assert.equal(shortUrl('C:\\repos\\r'), 'C:\\repos\\r');
});

test('browseUrl saca las credenciales y el .git con barra final', () => {
  assert.equal(browseUrl(withPassword), 'https://github.com/u/r');
  assert.equal(browseUrl('https://github.com/u/r.git/'), 'https://github.com/u/r');
});

test('redactCredentials tapa claves y tokens, y deja los usuarios solos', () => {
  assert.equal(
    redactCredentials(`To ${withPassword}\n   abc..def  main -> main`),
    'To https://***@github.com/u/r.git\n   abc..def  main -> main',
  );
  assert.equal(redactCredentials(`https://${token}@github.com/u/r`), 'https://***@github.com/u/r');
  assert.equal(redactCredentials('ssh://git@github.com/u/r.git'), 'ssh://git@github.com/u/r.git');
  assert.equal(redactCredentials('https://miguel@github.com/u/r'), 'https://miguel@github.com/u/r');
  assert.equal(redactCredentials('sin urls'), 'sin urls');
});

test('parseFlight no deja pasar el token que imprime apus', () => {
  const f = parseFlight(0, `» git push\nTo ${withPassword}\n✔ main → origin/main\n  https://u:${token}@github.com/u/r\n`);
  assert.equal(f.detail, 'https://***@github.com/u/r');
  assert.ok(!f.output.includes(token));
});

test('flightEnv: en segundo plano no se abre ningún pedido de claves', () => {
  const base = { PATH: '/bin' };
  assert.deepEqual(flightEnv(base, false), { PATH: '/bin', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', LC_ALL: 'C' });
  assert.deepEqual(flightEnv(base, true), {
    PATH: '/bin',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    LC_ALL: 'C',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
  });
});

test('parseRemotes junta fetch y push', () => {
  const out = [
    'origin\thttps://github.com/u/r.git (fetch)',
    'origin\tgit@github.com:u/r.git (push)',
    'fork\t/srv/r (fetch)',
    'fork\t/srv/r (push)',
    '',
  ].join('\r\n');
  assert.deepEqual(parseRemotes(out), [
    { name: 'origin', fetchUrl: 'https://github.com/u/r.git', pushUrl: 'git@github.com:u/r.git' },
    { name: 'fork', fetchUrl: '/srv/r', pushUrl: '/srv/r' },
  ]);
  assert.deepEqual(parseRemotes(''), []);
});

// Salidas reales de apus 2.1.0 y de git.

test('diagnose: sin remoto', () => {
  const f = parseFlight(1, '✖ este repo no tiene remoto\n  git remote add origin <url>\n');
  assert.equal(diagnose(f), 'noRemote');
});

test('diagnose: el repo de GitHub ya no existe', () => {
  const f = parseFlight(
    3,
    [
      '» git push',
      'remote: Repository not found.',
      "fatal: repository 'https://github.com/u/viper.git/' not found",
      '✖ el push falló: main → origin/main',
    ].join('\n'),
  );
  assert.equal(diagnose(f), 'remoteNotFound');
  assert.equal(
    diagnose(parseFlight(3, "fatal: '../borrado' does not appear to be a git repository\n✖ el push falló: main → origin/main")),
    'remoteNotFound',
  );
});

test('diagnose: autenticación, antes que "no encontrado"', () => {
  const ssh = [
    'git@github.com: Permission denied (publickey).',
    'fatal: Could not read from remote repository.',
    '',
    'Please make sure you have the correct access rights',
    'and the repository exists.',
    '✖ el push falló: main → origin/main',
  ].join('\n');
  assert.equal(diagnose(parseFlight(3, ssh)), 'auth');
  assert.equal(
    diagnose(
      parseFlight(
        3,
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n✖ el push falló: main → origin/main",
      ),
    ),
    'auth',
  );
});

test('diagnose: el remoto tiene commits nuevos', () => {
  const f = parseFlight(3, ' ! [rejected]        main -> main (fetch first)\n✖ el push falló: main → origin/main\n');
  assert.equal(diagnose(f), 'behind');
});

test('diagnose: sin conexión, aunque SSH diga "Could not read from remote repository"', () => {
  const salidas = [
    "fatal: unable to access 'https://github.com/u/r.git/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/u/r.git/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server",
    'ssh: Could not resolve hostname github.com: No such host is known.\r\nfatal: Could not read from remote repository.',
    'ssh: connect to host github.com port 22: Network is unreachable\nfatal: Could not read from remote repository.',
  ];
  for (const salida of salidas) {
    assert.equal(diagnose(parseFlight(3, `${salida}\n✖ el push falló: main → origin/main`)), 'offline', salida);
  }
});

test('diagnose: con apus --json manda el motivo que da apus, no el texto', () => {
  const json = (reason: string) =>
    parseJsonFlight(3, JSON.stringify({ ok: false, code: 3, reason, summary: 'el push falló', committed: true }), 'Permission denied')!;
  assert.equal(diagnose(json('offline')), 'offline');
  assert.equal(diagnose(json('notFound')), 'remoteNotFound');
  assert.equal(diagnose(json('noRemote')), 'noRemote');
  assert.equal(diagnose(json('behind')), 'behind');
  assert.equal(diagnose(json('auth')), 'auth');
  // Un motivo sin arreglo propio no se adivina por el texto.
  assert.equal(diagnose(json('commit')), undefined);
});

test('diagnose: lo que no se reconoce, y lo que salió bien', () => {
  assert.equal(diagnose(parseFlight(1, '✖ el commit falló: hook\n')), undefined);
  assert.equal(diagnose(parseFlight(0, '✔ main → origin/main\n')), undefined);
});
