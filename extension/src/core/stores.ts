// Lo que la extensión recuerda. Todo lo demás lo lee de git.

import * as path from 'node:path';

/** Lo que usan estos stores de vscode.Memento. */
export interface Memento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface WatchEntry {
  on: boolean;
  /** Identidad del repo cuando se guardó (su primer commit). */
  id?: string;
}

export function repoKey(fsPath: string): string {
  const clean = path.resolve(fsPath);
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

/**
 * Qué repos se vigilan. Vive en globalState, que comparten todas las ventanas.
 * Se guarda por carpeta, junto con la identidad del repo: si borrás un repo y
 * clonás otro en la misma carpeta, el nuevo no hereda la vigilancia.
 */
export class WatchStore {
  static readonly KEY = 'apus.watched';

  constructor(private readonly memento: Memento) {}

  get(key: string): WatchEntry | undefined {
    const value = this.all()[key];
    if (typeof value === 'boolean') {
      return { on: value }; // formato de la 0.2
    }
    if (typeof value === 'object' && value !== null && typeof (value as WatchEntry).on === 'boolean') {
      const { on, id } = value as WatchEntry;
      return typeof id === 'string' ? { on, id } : { on };
    }
    return undefined;
  }

  async set(key: string, entry: WatchEntry | undefined): Promise<void> {
    const all = this.all();
    if (entry) {
      all[key] = entry;
    } else {
      delete all[key];
    }
    await this.memento.update(WatchStore.KEY, all);
  }

  private all(): Record<string, unknown> {
    return { ...this.memento.get<Record<string, unknown>>(WatchStore.KEY, {}) };
  }
}

/**
 * ¿La vigilancia guardada es de este repo? `roots` son sus commits raíz. Sin
 * identidad guardada (la 0.2, o un repo que todavía no tenía commits) se acepta.
 */
export function belongsTo(entry: WatchEntry, roots: readonly string[]): boolean {
  return !entry.id || roots.includes(entry.id);
}

/**
 * Las carpetas que agregaste a mano y los repos que sacaste de la lista, en
 * esta ventana (workspaceState). Los repos que VS Code abre solo no se guardan.
 */
export class FolderList {
  static readonly ADDED = 'apus.addedFolders';
  static readonly HIDDEN = 'apus.hiddenRepos';

  constructor(private readonly memento: Memento) {}

  get added(): string[] {
    return strings(this.memento.get<unknown>(FolderList.ADDED, []));
  }

  isHidden(key: string): boolean {
    return strings(this.memento.get<unknown>(FolderList.HIDDEN, [])).includes(key);
  }

  isAdded(key: string): boolean {
    return this.added.some((p) => repoKey(p) === key);
  }

  async add(fsPath: string): Promise<void> {
    const key = repoKey(fsPath);
    await this.memento.update(FolderList.ADDED, [...this.added.filter((p) => repoKey(p) !== key), fsPath]);
    await this.setHidden(key, false);
  }

  /** Lo saca de la lista: si lo había agregado a mano, lo olvida; si lo abrió VS Code, lo esconde. */
  async remove(fsPath: string): Promise<void> {
    const key = repoKey(fsPath);
    await this.forget(fsPath);
    await this.setHidden(key, true);
  }

  async forget(fsPath: string): Promise<void> {
    const key = repoKey(fsPath);
    await this.memento.update(FolderList.ADDED, this.added.filter((p) => repoKey(p) !== key));
  }

  private async setHidden(key: string, hidden: boolean): Promise<void> {
    const current = strings(this.memento.get<unknown>(FolderList.HIDDEN, [])).filter((k) => k !== key);
    await this.memento.update(FolderList.HIDDEN, hidden ? [...current, key] : current);
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** Lo que identifica un aviso para dejarlo pasar: la regla y el archivo. */
export function allowKey(finding: { rule: string; path: string }): string {
  return `${finding.rule} ${finding.path}`;
}

/**
 * Avisos de la revisión antes de subir que el usuario marcó como falsos, por
 * repo. Vive en globalState y no en un ajuste: un repo clonado no puede traer
 * en su .vscode/settings.json permiso para subir su propio .env.
 */
export class AllowList {
  static readonly KEY = 'apus.allowedFindings';

  constructor(private readonly memento: Memento) {}

  list(repo: string): string[] {
    const value = this.all()[repo];
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
  }

  has(repo: string, finding: { rule: string; path: string }): boolean {
    return this.list(repo).includes(allowKey(finding));
  }

  async add(repo: string, finding: { rule: string; path: string }): Promise<void> {
    await this.save(repo, [...new Set([...this.list(repo), allowKey(finding)])]);
  }

  async remove(repo: string, keys: readonly string[]): Promise<void> {
    await this.save(repo, this.list(repo).filter((k) => !keys.includes(k)));
  }

  private async save(repo: string, keys: string[]): Promise<void> {
    const all = this.all();
    if (keys.length > 0) {
      all[repo] = keys;
    } else {
      delete all[repo];
    }
    await this.memento.update(AllowList.KEY, all);
  }

  private all(): Record<string, unknown> {
    return { ...this.memento.get<Record<string, unknown>>(AllowList.KEY, {}) };
  }
}
