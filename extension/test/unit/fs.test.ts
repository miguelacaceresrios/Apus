import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { apusDownload, findApus } from '../../src/core/binary';
import { withLock } from '../../src/core/lock';

const windows = process.platform === 'win32';
const EXE = windows ? 'apus.exe' : 'apus';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'apus-affinis-'));
}

async function fakeBinary(dir: string, name = EXE): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, '');
  await fs.chmod(file, 0o755);
  return file;
}

test('withLock corre la función y suelta el candado', async () => {
  const file = path.join(await tempDir(), 'apus.lock');
  const r = await withLock(file, async () => 42);
  assert.deepEqual(r, { acquired: true, value: 42 });
  await assert.rejects(fs.access(file));
});

test('withLock no entra si otro proceso vivo lo tiene', async () => {
  const file = path.join(await tempDir(), 'apus.lock');
  await withLock(file, async () => {
    const inner = await withLock(file, async () => 'no');
    assert.equal(inner.acquired, false);
  });
});

test('withLock pisa un candado abandonado', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'apus.lock');
  await fs.writeFile(file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  assert.deepEqual(await withLock(file, async () => 'ok'), { acquired: true, value: 'ok' });

  await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() - 3_600_000 }));
  assert.deepEqual(await withLock(file, async () => 'viejo'), { acquired: true, value: 'viejo' });

  await fs.writeFile(file, 'basura');
  assert.deepEqual(await withLock(file, async () => 'ilegible'), { acquired: true, value: 'ilegible' });
});

test('withLock suelta el candado aunque la función falle', async () => {
  const file = path.join(await tempDir(), 'apus.lock');
  await assert.rejects(
    withLock(file, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  await assert.rejects(fs.access(file));
});

test('findApus busca en el PATH', async () => {
  const empty = await tempDir();
  const withApus = await tempDir();
  const bin = await fakeBinary(withApus);
  const env = { PATH: [empty, `"${withApus}"`, 'relativa'].join(path.delimiter) };
  assert.deepEqual(await findApus('', env), { ok: true, path: bin });
  assert.deepEqual(await findApus('', { Path: empty }), { ok: false, problem: 'notOnPath' });
  assert.deepEqual(await findApus('', { Path: empty, PATH: withApus }), { ok: true, path: bin });
});

test('findApus usa la ruta configurada y rechaza rutas relativas', async () => {
  const dir = await tempDir();
  const bin = await fakeBinary(dir);
  const gone = path.join(dir, 'no-existe', EXE);
  assert.deepEqual(await findApus(bin, {}), { ok: true, path: bin });
  assert.deepEqual(await findApus(gone, {}), { ok: false, problem: 'missing', path: gone });
  assert.deepEqual(await findApus(`bin/${EXE}`, {}), { ok: false, problem: 'notAbsolute', path: `bin/${EXE}` });
});

test('findApus en Windows cambia apusw.exe por apus.exe y rechaza scripts', { skip: !windows }, async () => {
  const dir = await tempDir();
  const apusw = await fakeBinary(dir, 'apusw.exe');
  assert.deepEqual(await findApus(apusw, {}), { ok: false, problem: 'windowBinary', path: apusw });
  const apus = await fakeBinary(dir, 'apus.exe');
  assert.deepEqual(await findApus(apusw, {}), { ok: true, path: apus });
  const script = await fakeBinary(dir, 'apus.cmd');
  assert.deepEqual(await findApus(script, {}), { ok: false, problem: 'notExe', path: script });
});

test('apusDownload elige el binario de la release para cada sistema', () => {
  const latest = 'https://github.com/miguelacaceresrios/Apus/releases/latest';
  assert.deepEqual(apusDownload('win32', 'x64'), { url: `${latest}/download/apus.exe`, asset: 'apus.exe' });
  assert.deepEqual(apusDownload('win32', 'arm64'), { url: `${latest}/download/apus-windows-arm64.exe`, asset: 'apus-windows-arm64.exe' });
  assert.deepEqual(apusDownload('linux', 'x64'), { url: `${latest}/download/apus-linux-amd64`, asset: 'apus-linux-amd64' });
  assert.deepEqual(apusDownload('darwin', 'arm64'), { url: `${latest}/download/apus-darwin-arm64`, asset: 'apus-darwin-arm64' });
  // Sin binario para esta máquina, la página de releases.
  assert.deepEqual(apusDownload('freebsd', 'x64'), { url: latest });
  assert.deepEqual(apusDownload('linux', 'ia32'), { url: latest });
});
