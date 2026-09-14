import * as vscode from 'vscode';
import { ApusBinary } from './apusBinary';
import { registerCommands } from './commands';
import { getGitApi } from './git/api';
import { Registry } from './repos/registry';
import { WatchStore } from './repos/repoController';
import { Notifier } from './ui/notify';
import { ReposView } from './ui/reposView';
import { StatusBar } from './ui/statusBar';

const GUIDE_OFFERED = 'apus.guideOffered';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Apus', { log: true });
  context.subscriptions.push(log);

  const git = await getGitApi(log);
  if (!git) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('apus needs the built-in Git extension, and it is disabled (git.enabled).'),
    );
    return;
  }

  const binary = new ApusBinary(log);
  const lookup = await binary.refresh();
  const notifier = new Notifier(log);
  const registry = new Registry(git, {
    gitPath: git.git.path,
    log,
    binary: (interactive) => binary.get(interactive),
    watchStore: new WatchStore(context.globalState),
    onFlight: (report, repeated) => notifier.report(report, repeated),
  });

  context.subscriptions.push(binary, registry, new StatusBar(registry, binary), new ReposView(registry, binary));
  registerCommands(context, registry, binary, log);
  log.info(`apus affinis ${context.extension.packageJSON.version} activated; git at ${git.git.path}`);

  // La primera vez, si apus no está, la guía explica cómo conseguirlo.
  if (!lookup.ok && !context.globalState.get(GUIDE_OFFERED)) {
    await context.globalState.update(GUIDE_OFFERED, true);
    void vscode.commands.executeCommand('apus.getStarted');
  }
}

export function deactivate(): void {}
