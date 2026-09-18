// Pruebas dentro de un VS Code de verdad, con la extensión Git y apus reales.
// Las lanza scripts/integration.mjs, que arma los repos de prueba:
//
//   remotes/ok.git        remoto de "ok"
//   ws/ok                 repo al día, con origin
//   ws/solo               repo sin remoto
//   ws/secreto            repo con origin, para la revisión antes de subir
//   ws/viper              repo con origin...
//   ws/viper/viper        ...y otro repo adentro, sin remoto (lo que le pasó a viper)

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { diagnose } from '../../src/core/apus';
import { repoKey } from '../../src/core/stores';
import type { TestHandles } from '../../src/extension';
import type { RepoController } from '../../src/repos/repoController';
import type { Node } from '../../src/ui/reposView';

const EXTENSION = 'miguelacaceresr.apus-affinis';

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const fixture = path.dirname(ws);
  const results: string[] = [];
  const step = async (name: string, fn: () => void | Promise<void>) => {
    const started = Date.now();
    try {
      await fn();
      results.push(`ok   ${name} (${Date.now() - started} ms)`);
    } catch (e) {
      results.push(`FAIL ${name}\n${e instanceof Error ? e.stack : String(e)}`);
    }
    await fs.writeFile(path.join(fixture, 'results.txt'), results.join('\n') + '\n');
  };

  const api = await vscode.extensions.getExtension<TestHandles>(EXTENSION)!.activate();
  assert.ok(api, 'la extensión no devolvió las piezas: ¿corre en modo de pruebas?');
  const { registry, view, watchStore } = api;
  const find = (folder: string) => registry.all.find((c) => c.key === repoKey(folder));
  const get = (folder: string) => {
    const c = find(folder);
    assert.ok(c, `no está ${folder}`);
    return c;
  };
  const details = (c: RepoController) => {
    const node = view.getChildren().find((n) => n.kind === 'repo' && n.repo === c)!;
    return Object.fromEntries(
      view.getChildren(node).map((n: Node) => {
        const item = view.getTreeItem(n);
        const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
        const description = typeof item.description === 'string' ? item.description : '';
        return [(n as { field: string }).field, { label, description, command: item.command?.command }];
      }),
    );
  };

  await step('los comandos existen', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'apus.addFolder',
      'apus.changeFolder',
      'apus.changeUrl',
      'apus.remove',
      'apus.relocate',
      'apus.forget',
      'apus.fixLast',
      'apus.menu',
    ]) {
      assert.ok(all.includes(id), id);
    }
  });

  await step('encuentra los repos del workspace', async () => {
    await waitFor(() => ['ok', 'solo', 'viper'].every((n) => find(path.join(ws, n))), 30_000, 'repos');
    await waitFor(() => get(path.join(ws, 'ok')).remote !== undefined, 15_000, 'remoto de ok');
  });

  await step('un repo sin remoto se ve "sin conectar" y no hace auto-commit', () => {
    const solo = get(path.join(ws, 'solo'));
    assert.equal(solo.blocked, 'noRemote');
    assert.equal(solo.remote, undefined);
    const d = details(solo);
    assert.equal(d.url?.command, 'apus.changeUrl');
    assert.match(d.url?.description ?? '', /not connected|sin conectar/);
    assert.equal(d.folder?.command, 'apus.changeFolder');
  });

  await step('agregar el repo de adentro avisa en el de afuera, y se distinguen', async () => {
    const inner = await registry.addFolder(path.join(ws, 'viper', 'viper'));
    assert.ok(inner);
    const outer = get(path.join(ws, 'viper'));
    await waitFor(() => outer.nested.length === 1, 15_000, 'aviso de repo adentro');
    assert.ok(details(outer).nested);
    assert.notEqual(registry.label(outer), registry.label(inner));
  });

  await step('subir a mano con apus', async () => {
    const ok = get(path.join(ws, 'ok'));
    await fs.writeFile(path.join(ws, 'ok', 'nuevo.txt'), 'hola');
    await ok.pushNow();
    assert.equal(ok.lastError, undefined, output(ok));
    const log = execFileSync('git', ['log', '--oneline', '-1', 'main'], { cwd: path.join(fixture, 'remotes', 'ok.git'), encoding: 'utf8' });
    assert.match(log, /\S/);
    const remoteFiles = execFileSync('git', ['ls-tree', '--name-only', 'main'], {
      cwd: path.join(fixture, 'remotes', 'ok.git'),
      encoding: 'utf8',
    });
    assert.match(remoteFiles, /nuevo\.txt/);
  });

  await step('URL a un repo que no existe: error reconocido; cambiarla lo limpia y sube', async () => {
    const solo = get(path.join(ws, 'solo'));
    await solo.setRemoteUrl(path.join(fixture, 'remotes', 'borrado.git'));
    assert.equal((await solo.readRemote())?.name, 'origin');
    await solo.pushNow();
    assert.ok(solo.lastError, 'tendría que fallar');
    assert.equal(diagnose(solo.lastError.flight), 'remoteNotFound', solo.lastError.flight.output);
    assert.ok(details(solo).error);

    const bare = path.join(fixture, 'remotes', 'solo.git');
    execFileSync('git', ['init', '--bare', '--quiet', bare]);
    await solo.setRemoteUrl(bare);
    assert.equal(solo.lastError, undefined);
    await solo.pushNow();
    assert.equal(solo.lastError, undefined, output(solo));
    await waitFor(() => solo.upstream !== undefined && solo.blocked === undefined, 15_000, 'upstream de solo');
  });

  await step('otro repo en la misma carpeta no hereda la vigilancia', async () => {
    const folder = path.join(ws, 'solo');
    await registry.remove(get(folder));
    assert.equal(find(folder), undefined);
    await watchStore.set(repoKey(folder), { on: true, id: '0000000000000000000000000000000000000000' });
    const again = await registry.addFolder(folder);
    assert.ok(again);
    await waitFor(() => watchStore.get(repoKey(folder)) === undefined, 15_000, 'vigilancia reseteada');
    assert.equal(again.watching, false);
  });

  await step('pausar limpia un error viejo', async () => {
    const solo = get(path.join(ws, 'solo'));
    await solo.setRemoteUrl(path.join(fixture, 'remotes', 'borrado.git'));
    await fs.writeFile(path.join(ws, 'solo', 'otro.txt'), 'x');
    await solo.pushNow();
    assert.ok(solo.lastError);
    await solo.setWatching(false);
    assert.equal(solo.lastError, undefined);
  });

  await step('un .env nuevo frena el auto-commit; con .gitignore sube lo demás', async () => {
    const folder = path.join(ws, 'secreto');
    const bare = path.join(fixture, 'remotes', 'secreto.git');
    const commits = () => execFileSync('git', ['rev-list', '--count', 'main'], { cwd: bare, encoding: 'utf8' }).trim();
    const repo = get(folder);
    assert.equal(commits(), '1');

    await repo.setWatching(true);
    await fs.writeFile(path.join(folder, '.env'), 'API_PASSWORD=hunter2\n');
    await fs.writeFile(path.join(folder, 'notas.md'), 'algo\n');
    await waitFor(() => repo.held !== undefined, 60_000, 'auto-commit frenado');
    assert.deepEqual(
      repo.held!.map((f) => `${f.rule} ${f.path}`),
      ['envFile .env'],
    );
    assert.ok(details(repo).held);
    assert.equal(commits(), '1', 'no tendría que haber subido nada');

    await repo.ignoreFile(repo.held![0]!);
    assert.equal(repo.held, undefined);
    await waitFor(() => commits() === '2', 60_000, 'auto-commit después de .gitignore');
    const files = execFileSync('git', ['ls-tree', '--name-only', 'main'], { cwd: bare, encoding: 'utf8' });
    assert.match(files, /notas\.md/);
    assert.doesNotMatch(files, /^\.env$/m);

    // El mensaje nombra los archivos, los lista en el cuerpo y lleva el trailer.
    const message = execFileSync('git', ['log', '-1', '--format=%B', 'main'], { cwd: bare, encoding: 'utf8' });
    assert.match(message, /^chore: update .*notas\.md/, message);
    assert.match(message, /^A notas\.md$/m, message);
    assert.match(message, /^Apus-Auto: true$/m, message);
    await repo.setWatching(false);
  });

  await step('sin conexión: no pide arreglo, reintenta solo, y cambiar la URL lo cancela', async () => {
    const folder = path.join(ws, 'viper', 'viper');
    const repo = get(folder);
    // Nada escucha en el puerto 1: git no llega al remoto.
    await repo.setRemoteUrl('https://127.0.0.1:1/u/r.git');
    await repo.setWatching(true);
    await fs.writeFile(path.join(folder, 'sin-red.txt'), 'x');
    await repo.pushNow();
    assert.ok(repo.lastError, 'tendría que fallar');
    assert.equal(repo.offline, true, output(repo));
    assert.ok(repo.retryAt !== undefined && repo.retryAt > Date.now(), 'reintento programado');
    const d = details(repo);
    assert.match(d.error?.label ?? '', /No connection|Sin conexión/);
    assert.equal(d.error?.command, 'apus.pushNow');

    const bare = path.join(fixture, 'remotes', 'adentro.git');
    execFileSync('git', ['init', '--bare', '--quiet', bare]);
    await repo.setRemoteUrl(bare);
    assert.equal(repo.lastError, undefined);
    assert.equal(repo.retryAt, undefined);
    await repo.setWatching(false);
  });

  await step('el botón de Source Control sube su repo, no el del editor', async () => {
    const folder = path.join(ws, 'viper', 'viper');
    const bare = path.join(fixture, 'remotes', 'adentro.git');
    await fs.writeFile(path.join(folder, 'desde-scm.txt'), 'x');
    // Lo que manda VS Code desde la barra de Source Control: el SourceControl del repo.
    await vscode.commands.executeCommand('apus.pushNow', { rootUri: vscode.Uri.file(folder) });
    const files = execFileSync('git', ['ls-tree', '--name-only', 'main'], { cwd: bare, encoding: 'utf8' });
    assert.match(files, /desde-scm\.txt/, output(get(folder)));
  });

  await step('borrar la carpeta de un repo: sin "spawn git ENOENT", y queda para buscarla u olvidarla', async () => {
    const folder = path.join(ws, 'ok');
    const ok = get(folder);
    await ok.setWatching(true);
    await removeDir(folder);
    await ok.pushNow();
    assert.ok(!ok.lastError || !/ENOENT/.test(ok.lastError.flight.output), output(ok));
    await waitFor(() => ok.missing || registry.lost.some((l) => l.key === repoKey(folder)), 30_000, 'carpeta perdida');
    const lost = registry.resolveLost(ok.missing ? ok : registry.lost.find((l) => l.key === repoKey(folder)));
    assert.ok(lost);
    await registry.forget(lost);
    await waitFor(() => !find(folder) || !find(folder)!.missing, 5000, 'olvidada');
    assert.ok(!registry.lost.some((l) => l.key === repoKey(folder)));
    assert.equal(watchStore.get(repoKey(folder)), undefined);
  });

  const failed = results.filter((r) => r.startsWith('FAIL'));
  if (failed.length > 0) {
    throw new Error(`${failed.length} failed:\n${failed.join('\n')}`);
  }
}

/** Lo que dijo apus en el último error, para el mensaje de una aserción. */
function output(c: RepoController): string | undefined {
  return c.lastError?.flight.output;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error(`timeout: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** En Windows, git o el watcher pueden tener algo abierto un instante. */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 20) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
