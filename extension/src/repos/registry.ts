import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from '../config';
import { embeddedRepos, exists, isDirectory } from '../core/inspect';
import { repoKey, type FolderList } from '../core/stores';
import type { GitAPI, Repository } from '../git/api';
import { RepoController, type LostFolder, type RepoServices } from './repoController';

/**
 * Todos los repos de la lista: los que abre VS Code solo y las carpetas que
 * agregaste a mano, menos los que sacaste. Multi-root no cambia nada: hay un
 * controlador por repo git, no por carpeta del workspace, y un archivo
 * pertenece al repo más profundo que lo contiene.
 */
export class Registry implements vscode.Disposable {
  private readonly controllers = new Map<string, RepoController>();
  private readonly listeners = new Map<string, vscode.Disposable>();
  /** Carpetas que estaban en la lista y ya no son un repo que se pueda abrir. */
  private readonly lostFolders = new Map<string, LostFolder>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private lastActive: RepoController | undefined;
  private watchingAny = false;
  private nestingTimer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly git: GitAPI, private readonly services: RepoServices, private readonly folders: FolderList) {
    for (const repo of git.repositories) {
      this.open(repo);
    }
    this.disposables.push(
      git.onDidOpenRepository((repo) => this.open(repo)),
      git.onDidCloseRepository((repo) => void this.close(repo)),
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

  get gitPath(): string {
    return this.services.gitPath;
  }

  /** Vigilados primero, después alfabético. */
  get all(): RepoController[] {
    return [...this.controllers.values()].sort(
      (a, b) => Number(b.watching) - Number(a.watching) || a.name.localeCompare(b.name),
    );
  }

  get lost(): LostFolder[] {
    return [...this.lostFolders.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Repos que VS Code tiene abiertos pero sacaste de la lista. */
  get hidden(): Repository[] {
    return this.git.repositories.filter((r) => r.rootUri.scheme === 'file' && this.folders.isHidden(repoKey(r.rootUri.fsPath)));
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

  /** El nombre para mostrar: la carpeta, y la de arriba si hay dos repos que se llaman igual. */
  label(c: RepoController): string {
    const twins = [...this.controllers.values()].filter((o) => o.name.toLowerCase() === c.name.toLowerCase());
    return twins.length > 1 ? `${c.name} (${path.basename(path.dirname(c.root.fsPath))})` : c.name;
  }

  has(fsPath: string): boolean {
    return this.controllers.has(repoKey(fsPath));
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
   * vista pasa su nodo, el menú el controlador, los links y avisos su clave),
   * el del editor, el único que hay, o el que elija el usuario.
   */
  async resolve(arg?: unknown): Promise<RepoController | undefined> {
    if (arg instanceof RepoController) {
      return arg;
    }
    if (typeof arg === 'object' && arg !== null && (arg as { repo?: unknown }).repo instanceof RepoController) {
      return (arg as { repo: RepoController }).repo;
    }
    if (typeof arg === 'string' && this.controllers.has(arg)) {
      return this.controllers.get(arg);
    }
    const all = this.all;
    if (all.length === 0) {
      const add = vscode.l10n.t('Add Folder…');
      const answer = await vscode.window.showInformationMessage(vscode.l10n.t('apus: there are no repositories on the list yet.'), add);
      if (answer === add) {
        await vscode.commands.executeCommand('apus.addFolder');
      }
      return undefined;
    }
    return this.fromEditor() ?? (all.length === 1 ? all[0] : this.pick());
  }

  /** La carpeta perdida sobre la que actúa un comando: de la vista, de un aviso, o un repo que desapareció. */
  resolveLost(arg: unknown): LostFolder | undefined {
    if (typeof arg !== 'object' || arg === null) {
      return typeof arg === 'string' ? (this.lostFolders.get(arg) ?? this.controllers.get(arg)?.asLost()) : undefined;
    }
    const a = arg as { entry?: LostFolder; repo?: unknown; key?: unknown; path?: unknown; name?: unknown };
    if (a.entry) {
      return a.entry;
    }
    if (a.repo instanceof RepoController) {
      return a.repo.asLost();
    }
    if (arg instanceof RepoController) {
      return arg.asLost();
    }
    if (typeof a.key === 'string' && typeof a.path === 'string' && typeof a.name === 'string') {
      return { key: a.key, path: a.path, name: a.name, reason: 'missing' };
    }
    return undefined;
  }

  async pick(title = vscode.l10n.t('apus · choose a repository')): Promise<RepoController | undefined> {
    const items = this.all.map((c) => ({
      label: `$(repo) ${this.label(c)}`,
      description: c.branch,
      detail: vscode.workspace.asRelativePath(c.root, true),
      controller: c,
    }));
    return (await vscode.window.showQuickPick(items, { title, matchOnDetail: true }))?.controller;
  }

  /** Vuelve a abrir las carpetas que agregaste a mano: VS Code no las recuerda. */
  async restore(): Promise<void> {
    await Promise.all(this.folders.added.map((p) => this.openAdded(p)));
    this.changed();
  }

  /** Suma una carpeta que ya es la raíz de un repo. Undefined si VS Code no la pudo abrir. */
  async addFolder(fsPath: string): Promise<RepoController | undefined> {
    await this.folders.add(fsPath);
    const c = await this.openAdded(fsPath);
    if (!c) {
      await this.folders.forget(fsPath);
      this.lostFolders.delete(repoKey(fsPath));
    }
    this.changed();
    return c;
  }

  /** Lo saca de la lista de esta ventana y deja de vigilarlo. */
  async remove(c: RepoController): Promise<void> {
    await this.services.watchStore.set(c.key, undefined);
    await this.folders.remove(c.root.fsPath);
    this.drop(c.key);
    this.services.log.info(`[${c.name}] removed from the list`);
    this.changed();
  }

  /** Olvida una carpeta perdida: sale de la lista y de lo vigilado. */
  async forget(entry: LostFolder): Promise<void> {
    await this.folders.forget(entry.path);
    await this.services.watchStore.set(entry.key, undefined);
    this.lostFolders.delete(entry.key);
    if (this.controllers.get(entry.key)?.missing) {
      this.drop(entry.key);
    }
    this.changed();
  }

  wasWatched(key: string): boolean {
    return this.services.watchStore.get(key)?.on === true;
  }

  dispose(): void {
    if (this.nestingTimer) {
      clearTimeout(this.nestingTimer);
    }
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

  private async openAdded(fsPath: string): Promise<RepoController | undefined> {
    const key = repoKey(fsPath);
    const name = path.basename(fsPath);
    const existing = this.controllers.get(key);
    if (existing) {
      this.lostFolders.delete(key);
      return existing;
    }
    if (!(await isDirectory(fsPath))) {
      this.lostFolders.set(key, { key, path: fsPath, name, reason: 'missing' });
      return undefined;
    }
    // Sin .git, vscode.git abriría el repo de más arriba, si lo hay.
    const repo = (await exists(path.join(fsPath, '.git'))) ? await this.openInGit(fsPath) : undefined;
    if (!repo || repoKey(repo.rootUri.fsPath) !== key) {
      this.lostFolders.set(key, { key, path: fsPath, name, reason: 'notRepo' });
      return undefined;
    }
    this.lostFolders.delete(key);
    this.open(repo);
    return this.controllers.get(key);
  }

  private async openInGit(fsPath: string): Promise<Repository | undefined> {
    const key = repoKey(fsPath);
    try {
      if (this.git.openRepository) {
        return (await this.git.openRepository(vscode.Uri.file(fsPath))) ?? undefined;
      }
      await vscode.commands.executeCommand('git.openRepository', fsPath);
      return this.git.repositories.find((r) => repoKey(r.rootUri.fsPath) === key);
    } catch (e) {
      this.services.log.warn(`could not open ${fsPath}:`, e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  private open(repo: Repository): void {
    if (repo.rootUri.scheme !== 'file') {
      return;
    }
    const key = repoKey(repo.rootUri.fsPath);
    if (this.controllers.has(key) || this.folders.isHidden(key)) {
      return;
    }
    const controller = new RepoController(repo, this.services);
    this.controllers.set(key, controller);
    this.listeners.set(key, controller.onDidChange(() => this.changed()));
    this.lostFolders.delete(key);
    this.services.log.info(`repository opened: ${repo.rootUri.fsPath}`);
    this.changed();
    this.scheduleNesting();
  }

  private async close(repo: Repository): Promise<void> {
    const key = repoKey(repo.rootUri.fsPath);
    const c = this.controllers.get(key);
    if (!c) {
      return;
    }
    this.drop(key);
    // Si se fue porque borraste la carpeta, que no desaparezca sin decir nada.
    if (!(await isDirectory(c.root.fsPath))) {
      this.lostFolders.set(key, c.asLost());
    }
    this.changed();
    this.scheduleNesting();
  }

  private drop(key: string): void {
    this.listeners.get(key)?.dispose();
    this.listeners.delete(key);
    this.controllers.get(key)?.dispose();
    this.controllers.delete(key);
  }

  /** Un repo dentro de otro se sube como un puntero vacío: se avisa en el de afuera. */
  private scheduleNesting(): void {
    if (this.nestingTimer) {
      clearTimeout(this.nestingTimer);
    }
    this.nestingTimer = setTimeout(() => {
      this.nestingTimer = undefined;
      void this.refreshNesting();
    }, 500);
  }

  private async refreshNesting(): Promise<void> {
    const all = [...this.controllers.values()];
    for (const outer of all) {
      const inside = all.filter((o) => o !== outer && o.key.startsWith(outer.key + path.sep)).map((o) => o.root.fsPath);
      const nested = inside.length > 0 ? await embeddedRepos(this.gitPath, outer.root.fsPath, inside).catch(() => []) : [];
      outer.setNested(nested);
    }
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
