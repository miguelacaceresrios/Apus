import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';
import { initRepo } from '../../src/core/git';
import { commitSigning, parseSigning, signsQuietly } from '../../src/core/signing';
import { tempDir } from './tmp';

const config = (...entries: [string, string][]) => entries.map(([k, v]) => `${k}\n${v}\0`).join('');

test('parseSigning: sin commit.gpgsign no hay firma', () => {
  assert.equal(parseSigning(''), undefined);
  assert.equal(parseSigning(config(['commit.gpgsign', 'false'], ['user.signingkey', 'ABC'])), undefined);
});

test('parseSigning: GPG, con el programa y la clave configurados', () => {
  assert.deepEqual(parseSigning(config(['commit.gpgsign', 'true'])), { format: 'openpgp', program: 'gpg', key: undefined });
  assert.deepEqual(parseSigning(config(['commit.gpgSign', 'yes'], ['gpg.program', 'C:/gpg/gpg.exe'], ['user.signingKey', 'ABC123'])), {
    format: 'openpgp',
    program: 'C:/gpg/gpg.exe',
    key: 'ABC123',
  });
  // gpg.openpgp.program gana sobre gpg.program, y la última entrada gana sobre las anteriores.
  assert.deepEqual(
    parseSigning(config(['commit.gpgsign', 'false'], ['commit.gpgsign', 'on'], ['gpg.program', 'gpg1'], ['gpg.openpgp.program', 'gpg2'])),
    { format: 'openpgp', program: 'gpg2', key: undefined },
  );
});

test('parseSigning: x509 y ssh', () => {
  assert.deepEqual(parseSigning(config(['commit.gpgsign', '1'], ['gpg.format', 'x509'])), {
    format: 'x509',
    program: 'gpgsm',
    key: undefined,
  });
  assert.deepEqual(parseSigning(config(['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['user.signingkey', '~/.ssh/id_ed25519.pub'])), {
    format: 'ssh',
    program: 'ssh-keygen',
    key: '~/.ssh/id_ed25519.pub',
  });
});

test('commitSigning lee el repo, y signsQuietly nunca pregunta', async () => {
  const dir = await tempDir();
  await initRepo('git', dir, 'main');
  // La configuración local gana sobre la global de la máquina que corre la prueba.
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  assert.equal(await commitSigning('git', dir), undefined);

  // Un "gpg" que rechaza las opciones: no pudo firmar sin preguntar.
  execFileSync('git', ['config', 'commit.gpgsign', 'true'], { cwd: dir });
  execFileSync('git', ['config', 'gpg.program', 'git'], { cwd: dir });
  const signing = await commitSigning('git', dir);
  assert.deepEqual(signing, { format: 'openpgp', program: 'git', key: undefined });
  assert.equal(await signsQuietly(signing, dir), false);

  // Sin el programa, se deja que el commit falle y apus diga por qué. Con SSH no hay ventana.
  assert.equal(await signsQuietly({ ...signing, program: path.join(dir, 'no-existe') }, dir), true);
  assert.equal(await signsQuietly({ format: 'ssh', program: 'ssh-keygen', key: undefined }, dir), true);
});
