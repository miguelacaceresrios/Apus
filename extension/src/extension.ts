import * as vscode from 'vscode';
import { ApusBinary } from './apusBinary';
import { registerCommands } from './commands';
import { getGitApi } from './git/api';
import { Registry } from './repos/registry';
import { WatchStore } from './repos/repoController';
import { Notifier } from './ui/notify';
import { ReposView } from './ui/reposView';
import { StatusBar } from './ui/statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Apus', { log: true });
  context.subscriptions.push(log);

  const git = await getGitApi(log);
  if (!git) {
    void vscode.window.showWarningMessage(
      'apus necesita la extensión Git de VS Code, y está desactivada (git.enabled).',
    );
    return;
  }

  const binary = new ApusBinary(log);
  const notifier = new Notifier(log);
  const registry = new Registry(git, {
    gitPath: git.git.path,
    log,
    binary: (interactive) => binary.get(interactive),
    watchStore: new WatchStore(context.globalState),
    onFlight: (report, repeated) => notifier.report(report, repeated),
  });

  context.subscriptions.push(binary, registry, new StatusBar(registry), new ReposView(registry));
  registerCommands(context, registry, binary, log);
  log.info(`apus affinis ${context.extension.packageJSON.version} activo; git en ${git.git.path}`);
}

export function deactivate(): void {}
