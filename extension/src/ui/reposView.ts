import * as vscode from 'vscode';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import { look, plural, summary, tooltip } from './describe';

/** La vista de la barra de actividad: un renglón por repo, con su estado. */
export class ReposView implements vscode.TreeDataProvider<RepoController>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RepoController | undefined>();
  private readonly view: vscode.TreeView<RepoController>;
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly registry: Registry) {
    this.view = vscode.window.createTreeView('apus.repos', { treeDataProvider: this });
    this.subscription = registry.onDidChange(() => this.refresh());
    this.refresh();
  }

  getChildren(element?: RepoController): RepoController[] {
    return element ? [] : this.registry.all;
  }

  getTreeItem(c: RepoController): vscode.TreeItem {
    const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
    const { icon, color } = look(c);
    item.id = c.key;
    item.description = summary(c);
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.contextValue = c.watching ? 'apus.repo.watching' : 'apus.repo.paused';
    item.command = { command: 'apus.menu', title: 'Menú', arguments: [c] };
    return item;
  }

  // El tooltip se arma al pasar el mouse, así los tiempos relativos están al día.
  resolveTreeItem(item: vscode.TreeItem, c: RepoController): vscode.TreeItem {
    item.tooltip = tooltip(c);
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.view.dispose();
    this.emitter.dispose();
  }

  private refresh(): void {
    this.emitter.fire(undefined);
    const withChanges = this.registry.all.filter((c) => c.pending > 0 || c.ahead > 0).length;
    this.view.badge = withChanges > 0
      ? { value: withChanges, tooltip: plural(withChanges, 'repo con cambios sin subir', 'repos con cambios sin subir') }
      : undefined;
  }
}
