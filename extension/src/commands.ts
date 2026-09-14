import * as vscode from 'vscode';
import { APUS_DOWNLOAD_URL, type ApusBinary } from './apusBinary';
import type { Registry } from './repos/registry';
import type { RepoController } from './repos/repoController';
import { showAutoCommits, showMenu } from './ui/menu';

export function registerCommands(
  context: vscode.ExtensionContext,
  registry: Registry,
  binary: ApusBinary,
  log: vscode.LogOutputChannel,
): void {
  // Los comandos que actúan sobre un repo lo reciben de la vista, del menú o de
  // un tooltip; desde la paleta, usan el del editor o preguntan.
  const onRepo = (fn: (repo: RepoController) => unknown) => async (arg?: unknown) => {
    const repo = await registry.resolve(arg);
    if (repo) {
      await fn(repo);
    }
  };

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'apus.menu': onRepo((repo) => showMenu(registry, repo)),
    'apus.toggleWatch': onRepo((repo) => repo.setWatching(!repo.watching)),
    'apus.watch': onRepo((repo) => repo.setWatching(true)),
    'apus.pause': onRepo((repo) => repo.setWatching(false)),
    'apus.pushNow': onRepo((repo) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('apus: pushing {0}', repo.name) },
        () => repo.pushNow(),
      ),
    ),
    'apus.showLog': onRepo(showAutoCommits),
    'apus.openSettings': () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
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
