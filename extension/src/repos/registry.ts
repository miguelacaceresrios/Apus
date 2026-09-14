import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from '../config';
import type { GitAPI, Repository } from '../git/api';
import { RepoController, repoKey, type RepoServices } from './repoController';

/**
 * Todos los repos de la ventana. Multi-root no cambia nada: hay un controlador
 * por repo git, no por carpeta del workspace, y un archivo pertenece al repo
 * más profundo que lo contiene.
 */
export class Registry implements vscode.Disposable {
  private readonly controllers = new Map<string, RepoController>();
  private readonly listeners = new Map<string, vscode.Disposable>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private lastActive: RepoController | undefined;
  private watchingAny = false;

  readonly onDidChange = this.emitter.event;

  constructor(git: GitAPI, private readonly services: RepoServices) {
    for (const repo of git.repositories) {
      this.open(repo);
    }
    this.disposables.push(
      git.onDidOpenRepository((repo) => this.open(repo)),
      git.onDidCloseRepository((repo) => this.close(repo)),
      vscode.window.onDidChangeActiveTextEditor(() => this.emitter.fire()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.find(doc.uri)?.noteSave()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        for (const c of this.controllers.values()) {
          if (e.affectsConfiguration(SECTION, c.root)) {
            c.reloadConfig();
          }
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        for (const c of this.controllers.values()) {
          c.sync();
        }
      }),
    );
  }

  /** Vigilados primero, después alfabético. */
  get all(): RepoController[] {
    return [...this.controllers.values()].sort(
      (a, b) => Number(b.watching) - Number(a.watching) || a.name.localeCompare(b.name),
    );
  }

  /** El repo del editor activo; si no hay, el último usado; si no, el primero. */
  get active(): RepoController | undefined {
    const fromEditor = this.fromEditor();
    if (fromEditor) {
      this.lastActive = fromEditor;
      return fromEditor;
    }
    if (this.lastActive && this.controllers.has(this.lastActive.key)) {
      return this.lastActive;
    }
    return this.all[0];
  }

  find(uri: vscode.Uri): RepoController | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const file = repoKey(uri.fsPath);
    let best: RepoController | undefined;
    for (const c of this.controllers.values()) {
      if ((file === c.key || file.startsWith(c.key + path.sep)) && (!best || c.key.length > best.key.length)) {
        best = c;
      }
    }
    return best;
  }

  /**
   * El repo sobre el que actúa un comando: el que viene como argumento (la
   * vista y el menú pasan el controlador; los links de los tooltips, su clave),
   * el del editor, el único que hay, o el que elija el usuario.
   */
  async resolve(arg?: unknown): Promise<RepoController | undefined> {
    if (arg instanceof RepoController) {
      return arg;
    }
    if (typeof arg === 'string' && this.controllers.has(arg)) {
      return this.controllers.get(arg);
    }
    const all = this.all;
    if (all.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('apus: there are no git repositories open in this window.'));
      return undefined;
    }
    return this.fromEditor() ?? (all.length === 1 ? all[0] : this.pick());
  }

  async pick(title = vscode.l10n.t('apus · choose a repository')): Promise<RepoController | undefined> {
    const items = this.all.map((c) => ({
      label: `$(repo) ${c.name}`,
      description: c.branch,
      detail: vscode.workspace.asRelativePath(c.root, true),
      controller: c,
    }));
    return (await vscode.window.showQuickPick(items, { title, matchOnDetail: true }))?.controller;
  }

  dispose(): void {
    for (const c of this.controllers.values()) {
      c.dispose();
    }
    for (const l of this.listeners.values()) {
      l.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private fromEditor(): RepoController | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? this.find(uri) : undefined;
  }

  private open(repo: Repository): void {
    if (repo.rootUri.scheme !== 'file') {
      return;
    }
    const key = repoKey(repo.rootUri.fsPath);
    if (this.controllers.has(key)) {
      return;
    }
    const controller = new RepoController(repo, this.services);
    this.controllers.set(key, controller);
    this.listeners.set(key, controller.onDidChange(() => this.changed()));
    this.services.log.info(`repository opened: ${repo.rootUri.fsPath}`);
    this.changed();
  }

  private close(repo: Repository): void {
    const key = repoKey(repo.rootUri.fsPath);
    this.listeners.get(key)?.dispose();
    this.listeners.delete(key);
    this.controllers.get(key)?.dispose();
    this.controllers.delete(key);
    this.changed();
  }

  private changed(): void {
    // La guía de primeros pasos marca "vigilá un repo" con esta clave.
    const watchingAny = [...this.controllers.values()].some((c) => c.watching);
    if (watchingAny !== this.watchingAny) {
      this.watchingAny = watchingAny;
      void vscode.commands.executeCommand('setContext', 'apus.watchingAny', watchingAny);
    }
    this.emitter.fire();
  }
}
