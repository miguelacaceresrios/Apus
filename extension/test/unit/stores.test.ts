import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { belongsTo, FolderList, repoKey, WatchStore, type Memento } from '../../src/core/stores';

class FakeMemento implements Memento {
  readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

test('WatchStore lee el formato de la 0.2 y guarda la identidad', async () => {
  const memento = new FakeMemento();
  memento.data.set(WatchStore.KEY, { '/viejo': true, '/raro': 'si' });
  const store = new WatchStore(memento);

  assert.deepEqual(store.get('/viejo'), { on: true });
  assert.equal(store.get('/raro'), undefined);
  assert.equal(store.get('/nada'), undefined);

  await store.set('/nuevo', { on: true, id: 'abc' });
  assert.deepEqual(store.get('/nuevo'), { on: true, id: 'abc' });
  assert.deepEqual(store.get('/viejo'), { on: true });

  await store.set('/nuevo', undefined);
  assert.equal(store.get('/nuevo'), undefined);
});

test('belongsTo: otro repo en la misma carpeta no hereda la vigilancia', () => {
  assert.equal(belongsTo({ on: true, id: 'abc' }, ['abc']), true);
  assert.equal(belongsTo({ on: true, id: 'abc' }, ['000', 'abc']), true);
  assert.equal(belongsTo({ on: true, id: 'abc' }, ['def']), false);
  assert.equal(belongsTo({ on: true, id: 'abc' }, []), false);
  // Sin identidad guardada se acepta: la 0.2, o un repo que no tenía commits.
  assert.equal(belongsTo({ on: true }, ['def']), true);
});

test('FolderList: agregar, sacar, esconder y volver a traer', async () => {
  const list = new FolderList(new FakeMemento());
  const a = process.platform === 'win32' ? 'C:\\Repos\\A' : '/repos/A';
  const b = process.platform === 'win32' ? 'C:\\Repos\\B' : '/repos/B';

  await list.add(a);
  await list.add(a);
  await list.add(b);
  assert.deepEqual(list.added, [a, b]);
  assert.ok(list.isAdded(repoKey(a)));

  await list.remove(a);
  assert.deepEqual(list.added, [b]);
  assert.ok(list.isHidden(repoKey(a)));

  await list.add(a);
  assert.ok(!list.isHidden(repoKey(a)));

  await list.forget(b);
  assert.deepEqual(list.added, [a]);
  assert.ok(!list.isHidden(repoKey(b)));
});
