// Con git de verdad, en carpetas temporales: repos adentro de otros, carpetas
// borradas y remotos.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { initRepo, readRemotes, rootCommits, setRemoteUrl } from '../../src/core/git';
import { findRepos, inspectFolder, samePath } from '../../src/core/inspect';
import { MissingFolderError, runProcess } from '../../src/core/process';

const GIT = 'git';

async function tempDir(): Promise<string> {
  // realpath: en macOS el temporal es un symlink, y git devuelve la ruta real.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'apus-affinis-')));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

async function repo(dir: string, file = 'a.txt'): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await initRepo(GIT, dir, 'main');
  await fs.writeFile(path.join(dir, file), 'hola');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'primero');
  return dir;
}

test('runProcess: carpeta borrada no es "spawn git ENOENT"', async () => {
  const dir = await tempDir();
  const gone = path.join(dir, 'borrado');
  await assert.rejects(runProcess(GIT, ['status'], { cwd: gone }), (e: unknown) => e instanceof MissingFolderError && e.folder === gone);
});

test('runProcess: un binario que no existe sigue siendo ENOENT', async () => {
  const dir = await tempDir();
  await assert.rejects(runProcess(path.join(dir, 'no-existe.exe'), [], { cwd: dir }), (e: unknown) => !(e instanceof MissingFolderError));
});

test('inspectFolder: repo, carpeta común, subcarpeta y carpeta que no existe', async () => {
  const dir = await tempDir();
  const r = await repo(path.join(dir, 'viper'));
  await fs.mkdir(path.join(r, 'src'));
  await fs.mkdir(path.join(dir, 'comun'));

  assert.deepEqual(await inspectFolder(GIT, r), { kind: 'repo', nested: [] });
  assert.deepEqual(await inspectFolder(GIT, path.join(dir, 'comun')), { kind: 'plain', nested: [] });
  const inside = await inspectFolder(GIT, path.join(r, 'src'));
  assert.equal(inside.kind, 'inside');
  assert.ok(inside.kind === 'inside' && samePath(inside.root, r));
  assert.deepEqual(await inspectFolder(GIT, path.join(dir, 'no-existe')), { kind: 'missing' });
});

test('inspectFolder: lo que le pasó a viper, una carpeta con el repo adentro', async () => {
  const dir = await tempDir();
  const outer = path.join(dir, 'Bothriechis-master');
  const inner = await repo(path.join(outer, 'Bothriechis-master'));

  // Antes de inicializar la de afuera: se ofrece el de adentro.
  assert.deepEqual(await inspectFolder(GIT, outer), { kind: 'plain', nested: [inner] });

  // Si ya la inicializaron, igual se avisa.
  await initRepo(GIT, outer, 'main');
  assert.deepEqual(await inspectFolder(GIT, outer), { kind: 'repo', nested: [inner] });

  // Con el de adentro en .gitignore no pasa nada malo: no se avisa.
  await fs.writeFile(path.join(outer, '.gitignore'), 'Bothriechis-master/\n');
  assert.deepEqual(await inspectFolder(GIT, outer), { kind: 'repo', nested: [] });
});

test('findRepos no entra en repos, saltea node_modules y ocultas, y corta', async () => {
  const dir = await tempDir();
  const a = await repo(path.join(dir, 'a'));
  await repo(path.join(a, 'adentro-de-a'));
  const b = await repo(path.join(dir, 'grupo', 'b'));
  await repo(path.join(dir, 'node_modules', 'x'));
  await repo(path.join(dir, '.oculta', 'y'));
  await repo(path.join(dir, '1', '2', '3', 'profundo'));

  assert.deepEqual(await findRepos(dir), [a, b].sort());
  assert.deepEqual(await findRepos(dir, 1), [a]);
  assert.deepEqual(await findRepos(dir, 3, 0), []);
});

test('rootCommits identifica al repo aunque cambie la carpeta', async () => {
  const dir = await tempDir();
  const r = await repo(path.join(dir, 'uno'));
  const roots = await rootCommits(GIT, r);
  assert.equal(roots.length, 1);

  // Otro repo en la misma carpeta: otra identidad.
  await fs.rm(r, { recursive: true, force: true });
  await repo(r, 'b.txt');
  assert.notDeepEqual(await rootCommits(GIT, r), roots);

  // Una copia del mismo repo: la misma.
  const copy = path.join(dir, 'copia');
  git(dir, 'clone', '--quiet', r, copy);
  assert.deepEqual(await rootCommits(GIT, copy), await rootCommits(GIT, r));

  const empty = path.join(dir, 'vacio');
  await fs.mkdir(empty);
  await initRepo(GIT, empty, 'main');
  assert.deepEqual(await rootCommits(GIT, empty), []);
});

test('setRemoteUrl agrega origin, lo cambia, y respeta una URL de push aparte', async () => {
  const dir = await tempDir();
  const r = await repo(path.join(dir, 'r'));

  await setRemoteUrl(GIT, r, { name: 'origin', url: 'https://github.com/u/viejo.git', exists: false, separatePushUrl: false });
  assert.deepEqual(await readRemotes(GIT, r), [
    { name: 'origin', fetchUrl: 'https://github.com/u/viejo.git', pushUrl: 'https://github.com/u/viejo.git' },
  ]);

  git(r, 'remote', 'set-url', '--push', 'origin', 'git@github.com:u/viejo.git');
  await setRemoteUrl(GIT, r, { name: 'origin', url: 'https://github.com/u/nuevo.git', exists: true, separatePushUrl: true });
  assert.deepEqual(await readRemotes(GIT, r), [
    { name: 'origin', fetchUrl: 'https://github.com/u/nuevo.git', pushUrl: 'https://github.com/u/nuevo.git' },
  ]);

  await assert.rejects(setRemoteUrl(GIT, r, { name: 'origin', url: 'x', exists: false, separatePushUrl: false }));
});
