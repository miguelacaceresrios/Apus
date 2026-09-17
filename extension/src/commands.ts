import * as vscode from 'vscode';
import { APUS_DOWNLOAD_URL, type ApusBinary } from './apusBinary';
import type { Registry } from './repos/registry';
import type { LostFolder, RepoController } from './repos/repoController';
import { explainNested, fixLast, openRemote, pushNow, removeRepo, changeUrl } from './ui/actions';
import { addFolder } from './ui/folders';
import { showAutoCommits, showMenu } from './ui/menu';
import { reviewAllowed, reviewHeld } from './ui/safety';

export function registerCommands(
  context: vscode.ExtensionContext,
  registry: Registry | undefined,
  binary: ApusBinary,
  log: vscode.LogOutputChannel,
): void {
  // Sin la extensión Git no hay repos, pero los comandos existen igual: los
  // botones de la guía no pueden terminar en "command not found".
  const withRegistry =
    <A extends unknown[]>(fn: (registry: Registry, ...args: A) => unknown) =>
    async (...args: A) => {
      if (!registry) {
        void vscode.window.showWarningMessage(vscode.l10n.t('apus needs the built-in Git extension, and it is disabled (git.enabled).'));
        return;
      }
      await fn(registry, ...args);
    };

  // Los comandos que actúan sobre un repo lo reciben de la vista, del menú, de
  // un tooltip o de un aviso; desde la paleta, usan el del editor o preguntan.
  const onRepo = (fn: (repo: RepoController, registry: Registry) => unknown) =>
    withRegistry(async (r, arg?: unknown) => {
      const repo = await r.resolve(arg);
      if (repo) {
        await fn(repo, r);
      }
    });
  const onLost = (fn: (entry: LostFolder, registry: Registry) => unknown) =>
    withRegistry(async (r, arg?: unknown) => {
      const entry = r.resolveLost(arg);
      if (entry) {
        await fn(entry, r);
      }
    });

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'apus.menu': onRepo((repo, r) => showMenu(r, repo)),
    'apus.toggleWatch': onRepo((repo) => repo.setWatching(!repo.watching)),
    'apus.watch': onRepo((repo) => repo.setWatching(true)),
    'apus.pause': onRepo((repo) => repo.setWatching(false)),
    'apus.pushNow': onRepo(pushNow),
    'apus.showLog': onRepo(showAutoCommits),
    'apus.addFolder': withRegistry((r, folder?: unknown) => addFolder(r, undefined, typeof folder === 'string' ? folder : undefined)),
    'apus.changeFolder': onRepo((repo, r) => addFolder(r, { repo })),
    'apus.changeUrl': onRepo(changeUrl),
    'apus.openRemote': onRepo(openRemote),
    'apus.revealFolder': onRepo((repo) => vscode.commands.executeCommand('revealFileInOS', repo.root)),
    'apus.remove': onRepo((repo, r) => removeRepo(r, repo)),
    'apus.relocate': onLost((entry, r) => addFolder(r, { lost: entry })),
    'apus.forget': onLost((entry, r) => r.forget(entry)),
    'apus.fixLast': onRepo((repo) => fixLast(repo, log)),
    'apus.explainNested': onRepo((repo, r) => explainNested(r, repo)),
    'apus.reviewHeld': onRepo(reviewHeld),
    'apus.reviewAllowed': onRepo(reviewAllowed),
    'apus.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    'apus.selectBinary': () => binary.choose(),
    'apus.fixBinary': () => binary.offerFix(),
    'apus.downloadApus': () => vscode.env.openExternal(vscode.Uri.parse(APUS_DOWNLOAD_URL)),
    'apus.getStarted': () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#apus.gettingStarted`, false),
    'apus.showOutput': () => log.show(),
  };

  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}
