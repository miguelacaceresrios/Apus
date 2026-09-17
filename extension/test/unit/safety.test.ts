// La revisión antes de subir. Los secretos de prueba se arman por partes: así
// este archivo no tiene ninguno escrito, y ni la propia revisión ni la
// protección de GitHub lo frenan.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { initRepo } from '../../src/core/git';
import {
  addToGitignore,
  checkPending,
  gitignoreEntry,
  parsePatch,
  parseStatus,
  scanLines,
  scanText,
  stopTracking,
  type Finding,
} from '../../src/core/safety';
import { tempDir } from './tmp';

const GIT = 'git';
const fake = {
  github: ['gh', 'p_', 'A1b2'.repeat(9)].join(''),
  aws: ['AK', 'IA', 'Q7PL2M4N8R3T5V6W'].join(''),
  privateKey: ['-----BEGIN ', 'OPENSSH PRIVATE KEY', '-----'].join(''),
  openai: ['sk-', 'proj-', 'a'.repeat(20), 'T3Blbk', 'FJ', 'b'.repeat(20)].join(''),
  anthropic: ['sk-', 'ant-', 'api03-', 'Z9'.repeat(45)].join(''),
  urlPassword: ['postgres://', 'app:', 'S3cr3tPass', '@db.internal.net/app'].join(''),
};

async function tempRepo(): Promise<string> {
  const dir = await tempDir('apus-affinis-safety-');
  await initRepo(GIT, dir, 'main');
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(GIT, args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

/** Sube lo commiteado a un remoto de prueba: lo que ya está en un remoto no se vuelve a revisar. */
async function publish(root: string): Promise<void> {
  const bare = await tempDir('apus-affinis-remote-');
  git(bare, 'init', '--bare', '--quiet');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '--quiet', '-u', 'origin', 'main');
}

async function write(root: string, file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

const brief = (findings: Finding[]) =>
  findings
    .map((f) => `${f.rule} ${f.path}${f.line ? `:${f.line}` : ''}${f.tracked ? ' (tracked)' : ''}${f.commit ? ' @commit' : ''}`)
    .sort();

const lines = (...text: string[]) => text.join('\n');

test('scanText reconoce los formatos conocidos', () => {
  const text = lines(
    'const a = 1;',
    `token: "${fake.github}"`,
    `aws_access_key_id = ${fake.aws}`,
    fake.privateKey,
    `OPENAI_API_KEY=${fake.openai}`,
    `ANTHROPIC_API_KEY=${fake.anthropic}`,
    `DATABASE_URL=${fake.urlPassword}`,
  );
  assert.deepEqual(
    scanText(text).map((h) => `${h.rule}:${h.line}`),
    ['githubToken:2', 'awsKey:3', 'privateKey:4', 'openaiKey:5', 'anthropicKey:6', 'urlPassword:7'],
  );
});

test('scanText no avisa por ejemplos de documentación', () => {
  const text = lines(
    `token: ${['gh', 'p_'].join('')}${'x'.repeat(36)}`,
    `aws: ${['AK', 'IA'].join('')}IOSFODNN7EXAMPLE`,
    ['https://user', ':password@', 'github.com/u/r'].join(''),
    ['postgres://app', ':${DB_PASSWORD}@', 'db.local/app'].join(''),
    ['https://u', ':<token>@', 'github.com'].join(''),
    'ssh://git@github.com/u/r.git',
  );
  assert.deepEqual(scanText(text), []);
});

test('scanLines usa los números de línea que recibe', () => {
  assert.deepEqual(scanLines([{ line: 40, text: `x = "${fake.aws}"` }]), [{ rule: 'awsKey', line: 40 }]);
});

test('scanText termina rápido con una línea gigante', () => {
  const started = Date.now();
  scanText(`sk-${'a'.repeat(500_000)}`);
  scanText(`postgres://${'a:'.repeat(200_000)}`);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test('parseStatus: lo que subiría, sin lo borrado ni los repos de adentro', () => {
  const out = ['?? .env', ' M src/a.ts', 'D  gone.txt', ' D gone2.txt', 'A  new.ts', '?? inner/', 'MM both.ts', ''].join('\0');
  assert.deepEqual(parseStatus(out), [
    { path: '.env', tracked: false },
    { path: 'src/a.ts', tracked: true },
    { path: 'new.ts', tracked: true },
    { path: 'both.ts', tracked: true },
  ]);
});

test('parsePatch: números de línea, commits, y un "+++" que es contenido', () => {
  const quoted = '"b/b \\"c\\".txt"';
  const diff = lines(
    'commit abc1234',
    '',
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,0 +2,2 @@',
    '++++ esto es contenido',
    '+segunda',
    '@@ -5 +7 @@',
    '-vieja',
    '+nueva',
    'diff --git a/borrado.txt b/borrado.txt',
    '--- a/borrado.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-chau',
    `diff --git ${quoted.replace('b/', 'a/')} ${quoted}`,
    '--- /dev/null',
    `+++ ${quoted}`,
    '@@ -0,0 +1 @@',
    '+x',
    'commit def5678',
    '',
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-uno',
    `+UNO${String.fromCharCode(13)}`,
    '',
  );
  assert.deepEqual(parsePatch(diff), [
    {
      commit: 'abc1234',
      path: 'a.txt',
      added: [
        { line: 2, text: '+++ esto es contenido' },
        { line: 3, text: 'segunda' },
        { line: 7, text: 'nueva' },
      ],
    },
    { commit: 'abc1234', path: 'b "c".txt', added: [{ line: 1, text: 'x' }] },
    { commit: 'def5678', path: 'a.txt', added: [{ line: 1, text: 'UNO' }] },
  ]);
});

test('gitignoreEntry ancla a la raíz y escapa lo especial', () => {
  const bs = '\\';
  assert.equal(gitignoreEntry('config/.env'), '/config/.env');
  assert.equal(gitignoreEntry('#raro!.txt'), `/${bs}#raro${bs}!.txt`);
  assert.equal(gitignoreEntry('a*b?[1].txt  '), `/a${bs}*b${bs}?${bs}[1${bs}].txt${bs} ${bs} `);
});

test('checkPending revisa exactamente lo que subiría apus', async () => {
  const root = await tempRepo();
  // Lo que ya está publicado no se vuelve a avisar.
  await write(root, 'config.ts', `export const token = "${fake.github}";\n`);
  await write(root, 'README.md', '# repo\n');
  await write(root, '.gitignore', 'ignorado.env\n');
  await write(root, 'viejo.pem', `${fake.privateKey}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'primero');
  await publish(root);

  await write(root, 'config.ts', `export const token = "${fake.github}";\nexport const other = 1;\n`);
  await write(root, 'README.md', `# repo\n\nDATABASE_URL=${fake.urlPassword}\n`);
  await write(root, '.env', 'PASSWORD=hunter2\n');
  await write(root, '.env.example', 'PASSWORD=\n');
  await write(root, 'ignorado.env', 'PASSWORD=hunter2\n');
  await write(root, 'src/keys.ts', `// claves\nconst aws = "${fake.aws}";\n`);
  await write(root, 'data.bin', Buffer.alloc(2000, 1));
  await write(root, 'imagen.png', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fake.github)]));
  await fs.rm(path.join(root, 'viejo.pem'));

  const { findings, partial } = await checkPending(GIT, root, { maxFileBytes: 1000 });
  assert.equal(partial, false);
  assert.deepEqual(brief(findings), ['awsKey src/keys.ts:2', 'envFile .env', 'largeFile data.bin', 'urlPassword README.md:3 (tracked)']);
});

test('checkPending revisa los commits que todavía no se subieron', async () => {
  const root = await tempRepo();
  await write(root, 'README.md', '# repo\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'primero');

  // Un commit con secretos hecho desde la terminal, sin subir.
  await write(root, '.env', 'X=1\n');
  await write(root, 'app.ts', `const t = "${fake.github}";\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'con secretos');
  // Aunque después se borren, siguen en ese commit, y el push lo sube.
  git(root, 'rm', '--quiet', '.env');
  await write(root, 'app.ts', 'const t = process.env.TOKEN;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'los saco');

  assert.deepEqual(brief((await checkPending(GIT, root, { maxFileBytes: 1_000_000 })).findings), [
    'envFile .env (tracked) @commit',
    'githubToken app.ts:1 (tracked) @commit',
  ]);

  // Una vez en el remoto, ya no hay nada que frenar.
  await publish(root);
  assert.deepEqual((await checkPending(GIT, root, { maxFileBytes: 1_000_000 })).findings, []);
});

test('checkPending en un repo sin commits, y con avisos permitidos', async () => {
  const root = await tempRepo();
  await write(root, 'id_ed25519', `${fake.privateKey}\n`);
  await write(root, 'id_ed25519.pub', 'ssh-ed25519 AAAA\n');
  await write(root, 'app.ts', `const key = "${fake.anthropic}";\n`);
  git(root, 'add', 'app.ts');

  const all = await checkPending(GIT, root, { maxFileBytes: 1_000_000 });
  assert.deepEqual(brief(all.findings), ['anthropicKey app.ts:1 (tracked)', 'privateKey id_ed25519:1', 'sshKey id_ed25519']);

  const allowed = await checkPending(GIT, root, { maxFileBytes: 1_000_000, isAllowed: (f) => f.path === 'app.ts' });
  assert.deepEqual(brief(allowed.findings), ['privateKey id_ed25519:1', 'sshKey id_ed25519']);
});

test('addToGitignore y stopTracking dejan de avisar', async () => {
  const root = await tempRepo();
  await write(root, 'credentials.json', '{}\n');
  await write(root, '.gitignore', 'node_modules');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'primero');
  await publish(root);

  await write(root, '.env.local', 'X=1\n');
  await write(root, 'credentials.json', '{"a": 1}\n');
  assert.deepEqual(brief((await checkPending(GIT, root, { maxFileBytes: 1_000_000 })).findings), [
    'credentials credentials.json (tracked)',
    'envFile .env.local',
  ]);

  await addToGitignore(root, '.env.local');
  await addToGitignore(root, '.env.local');
  assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), 'node_modules\n/.env.local\n');

  await stopTracking(GIT, root, 'credentials.json');
  assert.deepEqual((await checkPending(GIT, root, { maxFileBytes: 1_000_000 })).findings, []);
  assert.equal(await fs.readFile(path.join(root, 'credentials.json'), 'utf8'), '{"a": 1}\n');
});
