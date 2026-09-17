import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HeldBack } from '../../src/core/held';
import type { Finding } from '../../src/core/safety';
import type { RepositoryState } from '../../src/git/api';
import { snapshot } from '../../src/repos/state';

const env: Finding = { path: '.env', rule: 'envFile', tracked: false };
const token: Finding = { path: 'src/config.ts', rule: 'githubToken', line: 3, tracked: true };

test('HeldBack: sigue frenado hasta que cambian los archivos o se guarda uno', () => {
  const held = new HeldBack();
  assert.equal(held.findings, undefined);
  assert.equal(held.blocks('a'), false);

  assert.equal(held.hold([env], 'a'), true);
  assert.deepEqual(held.findings, [env]);
  assert.equal(held.blocks('a'), true);
  // Cambios nuevos: vale volver a revisar.
  assert.equal(held.blocks('b'), false);

  // Guardar puede haber sacado el secreto.
  held.noteSave();
  assert.equal(held.blocks('a'), false);
  assert.deepEqual(held.findings, [env]);
});

test('HeldBack: avisa una sola vez por lo mismo, en cualquier orden', () => {
  const held = new HeldBack();
  assert.equal(held.hold([env, token], 'a'), true);
  assert.equal(held.hold([token, env], 'b'), false);
  assert.equal(held.hold([token], 'b'), true);
  held.clear();
  assert.equal(held.findings, undefined);
  assert.equal(held.hold([token], 'b'), true);
});

/** Lo justo de vscode.git para armar una foto. */
function gitState(partial: Partial<Record<keyof RepositoryState, unknown>>): RepositoryState {
  const change = (fsPath: string) => ({ uri: { fsPath }, status: 5 });
  return {
    HEAD: { name: 'main', commit: 'abc', upstream: { remote: 'origin', name: 'main' }, ahead: 0 },
    remotes: [{ name: 'origin', fetchUrl: 'https://github.com/u/r.git', pushUrl: 'https://github.com/u/r.git' }],
    mergeChanges: [],
    indexChanges: [],
    workingTreeChanges: [change('/r/a.ts'), change('/r/logs/x.log')],
    untrackedChanges: [change('/r/b.ts')],
    onDidChange: () => ({ dispose() {} }),
    ...partial,
  } as unknown as RepositoryState;
}

test('snapshot: cambios, lo que cuenta, remoto y rama', () => {
  const s = snapshot(gitState({}), '/r', (rel) => rel.endsWith('.log'), true);
  assert.equal(s.pending, 3);
  assert.equal(s.relevant, 2);
  assert.equal(s.upstream, 'origin/main');
  assert.deepEqual(s.remote, { name: 'origin', url: 'https://github.com/u/r.git' });
  assert.equal(s.blocked, undefined);
  assert.equal(s.upToDate, false);
  assert.equal(s.changeSignature.split('\n').length, 2);
});

test('snapshot: por qué no hay auto-commit', () => {
  assert.equal(snapshot(gitState({}), '/r', () => false, false).blocked, 'untrusted');
  assert.equal(
    snapshot(gitState({ mergeChanges: [{ uri: { fsPath: '/r/a.ts' }, status: 1 }] }), '/r', () => false, true).blocked,
    'conflicts',
  );
  assert.equal(snapshot(gitState({ HEAD: { commit: 'abc' } }), '/r', () => false, true).blocked, 'detached');
  assert.equal(snapshot(gitState({ remotes: [] }), '/r', () => false, true).blocked, 'noRemote');
});

test('snapshot: al día, y rutas de Windows sin barras dobles', () => {
  const clean = gitState({
    workingTreeChanges: [],
    untrackedChanges: [],
    remotes: [{ name: 'origin', fetchUrl: 'C:\\\\repos\\\\r.git' }],
  });
  const s = snapshot(clean, '/r', () => false, true);
  assert.equal(s.upToDate, true);
  assert.equal(s.remote?.url, 'C:\\repos\\r.git');
});
