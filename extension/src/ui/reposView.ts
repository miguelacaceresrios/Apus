import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApusBinary } from '../apusBinary';
import { shortUrl } from '../core/remote';
import { formatRelative } from '../core/time';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import type { LostFolder } from '../repos/types';
import { look, needsAttention, summary, tooltip } from './describe';
import { heldSummary, location, ruleText } from './safety';
import { binaryProblem, clock, flightSummary, locale, lostReason, reposWithChanges, tildify, unpushed, when } from './text';

type Field = 'held' | 'error' | 'nested' | 'gone' | 'folder' | 'url' | 'branch' | 'history';

/**
 * Los nodos de la vista. Los comandos de los menús reciben el nodo: por eso
 * los de repo llevan `repo` y los de carpeta perdida `entry` (ver
 * Registry.resolve y Registry.resolveLost).
 */
export type Node =
  | { kind: 'problem' }
  | { kind: 'repo'; repo: RepoController }
  | { kind: 'lost'; entry: LostFolder }
  | { kind: 'detail'; repo: RepoController; field: Field };

const warningColor = new vscode.ThemeColor('problemsWarningIcon.foreground');

/**
 * La vista de la barra de actividad. Cada repo se despliega como una ficha:
 * carpeta, URL, rama y auto-commits, y un clic en la carpeta o en la URL las
 * cambia.
 */
export class ReposView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | Node[] | undefined>();
  private readonly view: vscode.TreeView<Node>;
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Un nodo por repo, siempre el mismo: así se puede refrescar un repo solo. */
  private readonly repoNodes = new Map<string, Node & { kind: 'repo' }>();
  /** Cambió algo mientras la vista no se veía: se redibuja al volver. */
  private stale = false;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly registry: Registry,
    private readonly binary: ApusBinary,
  ) {
    this.view = vscode.window.createTreeView('apus.repos', { treeDataProvider: this, showCollapseAll: true });
    this.subscriptions = [
      registry.onDidChange(() => this.refresh()),
      binary.onDidChange(() => this.refresh()),
      this.view.onDidChangeVisibility((e) => {
        if (e.visible && this.stale) {
          this.refresh();
        } else if (e.visible) {
          this.scheduleTick();
        }
      }),
    ];
    this.refresh();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const repos = this.registry.all.map((repo) => this.repoNode(repo));
      const lost = this.registry.lost.map((entry): Node => ({ kind: 'lost', entry }));
      // Sin nada, VS Code muestra el mensaje de bienvenida (viewsWelcome en package.json).
      if (repos.length + lost.length === 0) {
        return [];
      }
      const problem: Node[] = this.binary.state?.ok === false ? [{ kind: 'problem' }] : [];
      return [...problem, ...repos, ...lost];
    }
    if (node.kind !== 'repo') {
      return [];
    }
    const { repo } = node;
    const fields: Field[] = [];
    if (repo.missing) {
      fields.push('gone');
    } else {
      if (repo.held) {
        fields.push('held');
      }
      if (repo.lastError) {
        fields.push('error');
      }
      if (repo.nested.length > 0) {
        fields.push('nested');
      }
      fields.push('folder', 'url', 'branch', 'history');
    }
    return fields.map((field) => ({ kind: 'detail', repo, field }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'problem':
        return this.problemItem();
      case 'repo':
        return this.repoItem(node.repo);
      case 'lost':
        return lostItem(node.entry);
      case 'detail':
        return detailItem(node.repo, node.field);
    }
  }

  // El tooltip se arma al pasar el mouse, así los tiempos relativos están al día.
  resolveTreeItem(item: vscode.TreeItem, node: Node): vscode.TreeItem {
    if (node.kind === 'repo') {
      item.tooltip = tooltip(node.repo);
    }
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

  private problemItem(): vscode.TreeItem {
    const lookup = this.binary.state;
    const item = new vscode.TreeItem(vscode.l10n.t('apus is not available'));
    item.id = 'problem';
    item.description = lookup && !lookup.ok ? binaryProblem(lookup.problem, lookup.path) : undefined;
    item.iconPath = new vscode.ThemeIcon('warning', warningColor);
    item.command = { command: 'apus.fixBinary', title: vscode.l10n.t('Fix…') };
    item.tooltip = vscode.l10n.t('Click to install or locate apus.');
    return item;
  }

  private repoItem(c: RepoController): vscode.TreeItem {
    // Con pocos repos, la ficha se ve abierta; después VS Code recuerda lo que elegiste.
    const few = this.registry.all.length + this.registry.lost.length <= 3;
    const item = new vscode.TreeItem(
      this.registry.label(c),
      few ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const { icon, color } = look(c);
    item.id = `repo:${c.key}`;
    item.description = summary(c);
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.contextValue = ['apusRepo', c.missing ? 'missing' : c.watching ? 'watching' : 'paused', c.browseUrl() ? 'web' : ''].join(';');
    item.accessibilityInformation = {
      label: `${c.name}: ${item.description}${needsAttention(c) ? `. ${vscode.l10n.t('Needs your attention.')}` : ''}`,
    };
    return item;
  }

  private repoNode(repo: RepoController): Node & { kind: 'repo' } {
    let node = this.repoNodes.get(repo.key);
    if (node?.repo !== repo) {
      node = { kind: 'repo', repo };
      this.repoNodes.set(repo.key, node);
    }
    return node;
  }

  private refresh(): void {
    const all = this.registry.all;
    // El número sobre el ícono se ve aunque la vista esté cerrada.
    const withChanges = all.filter((c) => c.pending > 0 || c.ahead > 0).length;
    this.view.badge = withChanges > 0 ? { value: withChanges, tooltip: reposWithChanges(withChanges) } : undefined;

    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.view.visible) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const keys = new Set(all.map((c) => c.key));
    for (const key of this.repoNodes.keys()) {
      if (!keys.has(key)) {
        this.repoNodes.delete(key);
      }
    }
    this.emitter.fire(undefined);
    this.scheduleTick();
  }

  /** Las cuentas regresivas: una vez por segundo, solo los repos que cuentan, y solo con la vista a la vista. */
  private scheduleTick(): void {
    const counting = () => this.registry.all.filter((c) => (c.nextFlightAt ?? c.retryAt) !== undefined && !c.flying);
    if (this.timer || counting().length === 0) {
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (!this.view.visible) {
          return;
        }
        this.emitter.fire(counting().map((c) => this.repoNode(c)));
        this.scheduleTick();
      },
      1000 - (Date.now() % 1000) + 10,
    );
  }
}

function lostItem(entry: LostFolder): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.name);
  item.id = `lost:${entry.key}`;
  item.description = lostReason(entry);
  item.iconPath = new vscode.ThemeIcon('warning', warningColor);
  item.tooltip = `${entry.path}\n${vscode.l10n.t('Click to choose where it is now.')}`;
  item.contextValue = 'apus.lost';
  item.command = { command: 'apus.relocate', title: vscode.l10n.t('Locate Folder…'), arguments: [entry] };
  return item;
}

function detailItem(c: RepoController, field: Field): vscode.TreeItem {
  const item = new vscode.TreeItem('');
  item.id = `${field}:${c.key}`;
  const command = (id: string, title: string, arg: unknown = c.key) => ({ command: id, title, arguments: [arg] });

  switch (field) {
    case 'gone':
      item.label = vscode.l10n.t('Folder not found');
      item.description = tildify(c.root.fsPath);
      item.iconPath = new vscode.ThemeIcon('warning', warningColor);
      item.tooltip = vscode.l10n.t('Click to choose where it is now.');
      item.command = command('apus.relocate', vscode.l10n.t('Locate Folder…'), c.asLost());
      break;

    case 'held': {
      const held = c.held!;
      item.label = vscode.l10n.t('Held back');
      item.description = heldSummary(held);
      item.iconPath = new vscode.ThemeIcon('shield', warningColor);
      item.tooltip = [
        ...held.slice(0, 8).map((f) => `${location(f)} — ${ruleText(f)}`),
        vscode.l10n.t('Nothing is pushed while these are here. Click to review them.'),
      ].join('\n');
      item.command = command('apus.reviewHeld', vscode.l10n.t('Review…'));
      break;
    }

    case 'error': {
      const flight = c.lastError!.flight;
      if (c.offline) {
        item.label = vscode.l10n.t('No connection');
        item.description = c.retryAt !== undefined ? vscode.l10n.t('trying again at {0}', clock(c.retryAt)) : flightSummary(flight);
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.tooltip = [
          flightSummary(flight),
          c.retryAt !== undefined
            ? vscode.l10n.t('The commits stay here, and apus pushes them when it can reach the remote. Click to try now.')
            : vscode.l10n.t('The commits stay here. Click to try again.'),
        ].join('\n');
        item.command = command('apus.pushNow', vscode.l10n.t('Push Now'));
        break;
      }
      item.label = vscode.l10n.t('Last push failed');
      item.description = flightSummary(flight);
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.tooltip = [flightSummary(flight), flight.detail, vscode.l10n.t('Click to fix it.')].filter(Boolean).join('\n');
      item.command = command('apus.fixLast', vscode.l10n.t('Fix…'));
      break;
    }

    case 'nested':
      item.label = vscode.l10n.t('Repository inside');
      item.description = c.nested.map((p) => path.basename(p)).join(', ');
      item.iconPath = new vscode.ThemeIcon('warning', warningColor);
      item.tooltip = vscode.l10n.t('git pushes it as an empty pointer, not its files. Click for details.');
      item.command = command('apus.explainNested', vscode.l10n.t('Details'));
      break;

    case 'folder':
      item.label = vscode.l10n.t('Folder');
      item.description = tildify(c.root.fsPath);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = `${c.root.fsPath}\n${vscode.l10n.t('Click to use another folder.')}`;
      item.contextValue = 'apus.detail.folder';
      item.command = command('apus.changeFolder', vscode.l10n.t('Change Folder…'));
      break;

    case 'url':
      item.label = vscode.l10n.t('URL');
      if (c.remote) {
        item.description = shortUrl(c.remote.url);
        item.iconPath = new vscode.ThemeIcon('link');
        item.tooltip = `${shortUrl(c.remote.url)} (${c.remote.name})\n${vscode.l10n.t('Click to change where it pushes.')}`;
        item.contextValue = c.browseUrl() ? 'apus.detail.url;web' : 'apus.detail.url';
      } else {
        item.description =
          c.remoteNames.length > 1 ? vscode.l10n.t('{0} remotes and none is origin', c.remoteNames.length) : vscode.l10n.t('not connected');
        item.iconPath = new vscode.ThemeIcon('debug-disconnect', warningColor);
        item.tooltip = vscode.l10n.t('Click to connect the URL to push to.');
      }
      item.command = command('apus.changeUrl', vscode.l10n.t('Change URL…'));
      break;

    case 'branch': {
      item.label = vscode.l10n.t('Branch');
      const ahead = c.ahead > 0 ? ` · ${unpushed(c.ahead)}` : '';
      item.description = !c.branch
        ? vscode.l10n.t('HEAD detached')
        : c.upstream
          ? `${c.branch} → ${c.upstream}${ahead}`
          : vscode.l10n.t('{0}, not published yet', c.branch);
      item.iconPath = new vscode.ThemeIcon('git-branch');
      item.tooltip = vscode.l10n.t('last push: {0}', c.lastPushAt === undefined ? vscode.l10n.t('unknown') : when(c.lastPushAt));
      break;
    }

    case 'history':
      item.label = vscode.l10n.t('Auto-commits');
      item.description =
        c.lastAutoAt === undefined ? vscode.l10n.t('none yet') : vscode.l10n.t('last one {0}', formatRelative(c.lastAutoAt, locale()));
      item.iconPath = new vscode.ThemeIcon('history');
      item.tooltip = vscode.l10n.t('Click to see them.');
      item.command = command('apus.showLog', vscode.l10n.t('Auto-commits'));
      break;
  }
  return item;
}
