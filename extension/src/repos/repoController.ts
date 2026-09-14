import * as path from 'node:path';
import * as vscode from 'vscode';
import { readRepoConfig, type RepoConfig } from '../config';
import { autoMessage, flyApus, type Flight } from '../core/apus';
import { absoluteGitDir, autoCommits, browseUrl, lastAutoCommitAt, lastPushAt, type AutoCommit } from '../core/git';
import { compileGlobs } from '../core/glob';
import { withLock } from '../core/lock';
import { FlightScheduler } from '../core/scheduler';
import type { Repository } from '../git/api';

export type FlightKind = 'auto' | 'manual';

/** Por qué no se puede hacer auto-commit ahora. */
export type BlockReason = 'untrusted' | 'conflicts' | 'detached';

export interface FlightReport {
  repo: RepoController;
  kind: FlightKind;
  flight: Flight;
  /** Cambios que había al despegar. */
  changes: number;
}

export interface RepoServices {
  gitPath: string;
  log: vscode.LogOutputChannel;
  /** Ruta de apus, o undefined si no está. */
  binary(interactive: boolean): Promise<string | undefined>;
  watchStore: WatchStore;
  onFlight(report: FlightReport, repeatedError: boolean): void;
}

/** Qué repos se vigilan. Vive en globalState, que comparten todas las ventanas. */
export class WatchStore {
  private static readonly KEY = 'apus.watched';

  constructor(private readonly memento: vscode.Memento) {}

  get(key: string): boolean | undefined {
    return this.memento.get<Record<string, boolean>>(WatchStore.KEY, {})[key];
  }

  async set(key: string, on: boolean): Promise<void> {
    const all = { ...this.memento.get<Record<string, boolean>>(WatchStore.KEY, {}), [key]: on };
    await this.memento.update(WatchStore.KEY, all);
  }
}

export function repoKey(fsPath: string): string {
  const clean = path.resolve(fsPath);
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

/** Un repo: su estado, su vigilancia y sus vuelos. */
export class RepoController implements vscode.Disposable {
  readonly root: vscode.Uri;
  readonly name: string;
  readonly key: string;

  private _config: RepoConfig;
  private _watching: boolean;
  private _flying = false;
  private _pending = 0;
  private _relevant = 0;
  private _ahead = 0;
  private _branch: string | undefined;
  private _upstream: string | undefined;
  private _blocked: BlockReason | undefined;
  private _lastPushAt: number | undefined;
  private _lastAutoAt: number | undefined;
  private _lastError: { flight: Flight; at: number } | undefined;

  private ignored: (relativePath: string) => boolean;
  private changeSignature = '';
  private headSignature = '';
  private readonly scheduler: FlightScheduler;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChange = this.emitter.event;

  constructor(private readonly repo: Repository, private readonly services: RepoServices) {
    this.root = repo.rootUri;
    this.name = path.basename(repo.rootUri.fsPath);
    this.key = repoKey(repo.rootUri.fsPath);
    this._config = readRepoConfig(this.root);
    this.ignored = this.compileIgnored();
    this._watching = services.watchStore.get(this.key) ?? this._config.autoStart;
    this.scheduler = new FlightScheduler(
      () => this.fly('auto'),
      this._config,
      (e) => services.log.error(`[${this.name}]`, e),
    );

    this.disposables.push(this.emitter, repo.state.onDidChange(() => this.sync()));
    this.sync();
  }

  get config(): RepoConfig { return this._config; }
  get watching(): boolean { return this._watching; }
  get flying(): boolean { return this._flying; }
  /** Archivos con cambios, cuenten o no para el auto-commit. */
  get pending(): number { return this._pending; }
  /** Archivos con cambios que no están en apus.ignorePatterns. */
  get relevant(): number { return this._relevant; }
  get ahead(): number { return this._ahead; }
  get branch(): string | undefined { return this._branch; }
  get upstream(): string | undefined { return this._upstream; }
  get blocked(): BlockReason | undefined { return this._blocked; }
  get nextFlightAt(): number | undefined { return this.scheduler.dueAt; }
  get lastPushAt(): number | undefined { return this._lastPushAt; }
  get lastAutoAt(): number | undefined { return this._lastAutoAt; }
  get lastError(): { flight: Flight; at: number } | undefined { return this._lastError; }

  async setWatching(on: boolean): Promise<void> {
    this._watching = on;
    await this.services.watchStore.set(this.key, on);
    this.services.log.info(`[${this.name}] ${on ? 'watching' : 'paused'}`);
    this.considerFlight(on);
    this.emitter.fire();
  }

  pushNow(): Promise<void> {
    return this.fly('manual');
  }

  /** Se guardó un archivo del repo: el repo no está quieto, la espera vuelve a empezar. */
  noteSave(): void {
    if (this.canAutoFly()) {
      this.scheduler.poke();
      this.emitter.fire();
    }
  }

  reloadConfig(): void {
    this._config = readRepoConfig(this.root);
    this.ignored = this.compileIgnored();
    this._watching = this.services.watchStore.get(this.key) ?? this._config.autoStart;
    this.scheduler.setOptions(this._config);
    this.changeSignature = '';
    this.sync();
  }

  autoCommits(): Promise<AutoCommit[]> {
    return autoCommits(this.services.gitPath, this.root.fsPath, this._config.logSize);
  }

  /** URL navegable del remoto, si es un host web. */
  browseUrl(): string | undefined {
    const remotes = this.repo.state.remotes;
    const wanted = this._upstream?.split('/')[0] ?? 'origin';
    const remote = remotes.find((r) => r.name === wanted) ?? remotes[0];
    const url = remote?.fetchUrl ?? remote?.pushUrl;
    return url ? browseUrl(url) : undefined;
  }

  /** Recalcula todo desde el estado que mantiene vscode.git. */
  sync(): void {
    const state = this.repo.state;
    const status = new Map<string, number>();
    for (const change of [...state.mergeChanges, ...state.indexChanges, ...state.workingTreeChanges, ...(state.untrackedChanges ?? [])]) {
      status.set(change.uri.fsPath, change.status);
    }
    const relevant = [...status.keys()].filter((p) => !this.ignored(path.relative(this.root.fsPath, p)));

    const head = state.HEAD;
    this._pending = status.size;
    this._relevant = relevant.length;
    this._branch = head?.name;
    this._upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
    this._ahead = head?.ahead ?? 0;
    this._blocked = !vscode.workspace.isTrusted
      ? 'untrusted'
      : state.mergeChanges.length > 0
        ? 'conflicts'
        : head && !head.name
          ? 'detached'
          : undefined;

    const headSignature = `${head?.commit}|${this._upstream}|${this._ahead}`;
    if (headSignature !== this.headSignature) {
      this.headSignature = headSignature;
      void this.refreshHistory();
    }

    // vscode.git avisa aunque no haya nada nuevo (por ejemplo, al volver a la
    // ventana): solo un cambio real en la lista reinicia la espera.
    const changeSignature = relevant.map((p) => `${status.get(p)} ${p}`).sort().join('\n');
    const changed = changeSignature !== this.changeSignature;
    this.changeSignature = changeSignature;
    this.considerFlight(changed);
    this.emitter.fire();
  }

  dispose(): void {
    this.scheduler.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private canAutoFly(): boolean {
    return this._watching && !this._blocked && this._relevant > 0;
  }

  private considerFlight(restart: boolean): void {
    if (!this.canAutoFly()) {
      this.scheduler.cancel();
    } else if (restart || this.scheduler.dueAt === undefined) {
      this.scheduler.poke();
    }
  }

  private async fly(kind: FlightKind): Promise<void> {
    const { log } = this.services;
    if (this._flying) {
      if (kind === 'manual') {
        void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: already pushing.', this.name));
      }
      return;
    }
    if (kind === 'auto') {
      // Pudieron pausarlo desde otra ventana.
      this._watching = this.services.watchStore.get(this.key) ?? this._config.autoStart;
      if (!this.canAutoFly()) {
        this.emitter.fire();
        return;
      }
    }

    const binary = await this.services.binary(kind === 'manual');
    if (!binary) {
      return;
    }

    const changes = this._pending;
    this._flying = true;
    this.emitter.fire();
    try {
      const gitDir = await absoluteGitDir(this.services.gitPath, this.root.fsPath);
      const result = await withLock(path.join(gitDir, 'apus.lock'), async () => {
        if (kind === 'auto') {
          // Otra ventana pudo haber subido hace nada.
          const last = await lastAutoCommitAt(this.services.gitPath, this.root.fsPath);
          if (last !== undefined && Date.now() - last < this._config.minGapMs) {
            log.info(`[${this.name}] auto-commit skipped: the last one was ${Math.round((Date.now() - last) / 1000)} s ago`);
            return undefined;
          }
        }
        const message = kind === 'auto' ? autoMessage(this._config.messageTemplate, new Date()) : undefined;
        log.info(`[${this.name}] ${kind === 'auto' ? 'auto-commit' : 'manual push'} with ${binary}`);
        return flyApus(binary, this.root.fsPath, message);
      });

      if (!result.acquired) {
        log.info(`[${this.name}] another process is pushing this repo${result.holder ? ` (pid ${result.holder.pid})` : ''}`);
        if (kind === 'manual') {
          void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: another window is pushing this repo.', this.name));
        }
        return;
      }
      if (result.value) {
        this.report(kind, result.value, changes);
      }
    } catch (e) {
      const summary = e instanceof Error ? e.message : String(e);
      this.report(kind, { code: -1, ok: false, summary, detail: undefined, committed: false, pushed: false, output: summary }, changes);
    } finally {
      this._flying = false;
      await this.refreshHistory();
      this.sync();
    }
  }

  private report(kind: FlightKind, flight: Flight, changes: number): void {
    const { log } = this.services;
    if (flight.output) {
      log.info(`[${this.name}]\n${flight.output}`);
    }
    let repeated = false;
    if (flight.ok) {
      this._lastError = undefined;
    } else {
      repeated = this._lastError?.flight.summary === flight.summary && this._lastError?.flight.code === flight.code;
      this._lastError = { flight, at: Date.now() };
      log.warn(`[${this.name}] apus exited with code ${flight.code}`);
    }
    this.services.onFlight({ repo: this, kind, flight, changes }, repeated);
  }

  private async refreshHistory(): Promise<void> {
    const { gitPath, log } = this.services;
    try {
      const [push, auto] = await Promise.all([
        this._upstream ? lastPushAt(gitPath, this.root.fsPath, this._upstream) : Promise.resolve(undefined),
        lastAutoCommitAt(gitPath, this.root.fsPath),
      ]);
      this._lastPushAt = push;
      this._lastAutoAt = auto;
      if (auto !== undefined) {
        this.scheduler.noteFlight(auto);
      }
      this.emitter.fire();
    } catch (e) {
      log.warn(`[${this.name}] could not read history:`, e instanceof Error ? e.message : String(e));
    }
  }

  private compileIgnored(): (relativePath: string) => boolean {
    return compileGlobs(this._config.ignorePatterns, (pattern, error) =>
      this.services.log.warn(`[${this.name}] apus.ignorePatterns: skipping "${pattern}": ${error.message}`),
    );
  }
}
