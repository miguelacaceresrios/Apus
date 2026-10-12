import * as vscode from 'vscode';
import { ApusBinary } from './apusBinary';
import { registerCommands } from './commands';
import { readSafetyConfig } from './config';
import { AllowList, FolderList, WatchStore } from './core/stores';
import { getGitApi } from './git/api';
import { Registry } from './repos/registry';
import { Notifier } from './ui/notify';
import { ReposView } from './ui/reposView';
import { confirmHeld } from './ui/safety';
import { StatusBar } from './ui/statusBar';

const GUIDE_OFFERED = 'apus.guideOffered';

/** Solo en las pruebas de integración (test/integration): las piezas, para mirarlas desde adentro. */
export interface TestHandles {
  registry: Registry;
  view: ReposView;
  watchStore: WatchStore;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestHandles | undefined> {
  const log = vscode.window.createOutputChannel('Apus', { log: true });
  const binary = new ApusBinary(log);
  context.subscriptions.push(log, binary);

  const [git, lookup] = await Promise.all([getGitApi(log), binary.refresh()]);
  if (!git) {
    registerCommands(context, undefined, binary, log);
    void vscode.window.showWarningMessage(vscode.l10n.t('apus needs the built-in Git extension, and it is disabled (git.enabled).'));
    return undefined;
  }

  const notifier = new Notifier(log);
  const watchStore = new WatchStore(context.globalState);
  const registry = new Registry(
    git,
    {
      gitPath: git.git.path,
      log,
      binary: (interactive) => binary.get(interactive),
      watchStore,
      onFlight: (report, repeated) => notifier.report(report, repeated),
      onMissing: (repo) => notifier.missing(repo),
      onReplaced: (repo) => notifier.replaced(repo),
      safety: readSafetyConfig,
      allowList: new AllowList(context.globalState),
      onHeld: (repo, findings) => notifier.held(repo, findings),
      confirmHeld,
    },
    new FolderList(context.workspaceState),
  );

  const view = new ReposView(registry, binary);
  context.subscriptions.push(registry, new StatusBar(registry, binary), view);
  registerCommands(context, registry, binary, log);
  void registry.restore();
  const { version } = context.extension.packageJSON as { version: string };
  log.info(`apus affinis ${version} activated; git at ${git.git.path}`);

  // La primera vez, si apus no está, la guía explica cómo conseguirlo.
  if (!lookup.ok && !context.globalState.get(GUIDE_OFFERED)) {
    await context.globalState.update(GUIDE_OFFERED, true);
    void vscode.commands.executeCommand('apus.getStarted');
  }
  return context.extensionMode === vscode.ExtensionMode.Test ? { registry, view, watchStore } : undefined;
}

export function deactivate(): void {}
