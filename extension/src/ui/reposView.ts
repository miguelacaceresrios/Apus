import * as vscode from 'vscode';
import type { ApusBinary } from '../apusBinary';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import { look, summary, tooltip } from './describe';
import { reposWithChanges } from './text';

/** La vista de la barra de actividad: un renglón por repo, con su estado. */
export class ReposView implements vscode.TreeDataProvider<RepoController>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RepoController | undefined>();
  private readonly view: vscode.TreeView<RepoController>;
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly registry: Registry, private readonly binary: ApusBinary) {
    this.view = vscode.window.createTreeView('apus.repos', { treeDataProvider: this });
    this.subscriptions = [
      registry.onDidChange(() => this.refresh()),
      binary.onDidChange(() => this.refresh()),
      this.view.onDidChangeVisibility(() => this.refresh()),
    ];
    this.refresh();
  }

  getChildren(element?: RepoController): RepoController[] {
    // Sin apus la lista queda vacía y VS Code muestra el mensaje de bienvenida
    // con los botones para arreglarlo (viewsWelcome en package.json).
    if (element || this.binary.state?.ok === false) {
      return [];
    }
    return this.registry.all;
  }

  getTreeItem(c: RepoController): vscode.TreeItem {
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    const { icon, color } = look(c);
    item.id = c.key;
    item.description = summary(c);
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.contextValue = c.watching ? 'apus.repo.watching' : 'apus.repo.paused';
    item.command = { command: 'apus.menu', title: vscode.l10n.t('Menu'), arguments: [c] };
    item.accessibilityInformation = { label: `${c.name}: ${item.description}` };
    return item;
  }

  // El tooltip se arma al pasar el mouse, así los tiempos relativos están al día.
  resolveTreeItem(item: vscode.TreeItem, c: RepoController): vscode.TreeItem {
    item.tooltip = tooltip(c);
    return item;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.view.dispose();
    this.emitter.dispose();
  }

  private refresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.emitter.fire(undefined);

    const all = this.registry.all;
    const withChanges = all.filter((c) => c.pending > 0 || c.ahead > 0).length;
    this.view.badge = withChanges > 0 ? { value: withChanges, tooltip: reposWithChanges(withChanges) } : undefined;

    // Las cuentas regresivas corren solo mientras la vista está a la vista.
    if (this.view.visible && all.some((c) => c.nextFlightAt !== undefined && !c.flying)) {
      this.timer = setTimeout(() => this.refresh(), 1000 - (Date.now() % 1000) + 10);
    }
  }
}
