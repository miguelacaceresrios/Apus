import * as path from 'node:path';
import * as vscode from 'vscode';
import { readRepoConfig, type RepoConfig, type SafetyConfig } from '../config';
import { autoMessage, flyApus, type Flight } from '../core/apus';
import {
  absoluteGitDir,
  autoCommits,
  browseUrl,
  lastAutoCommitAt,
  lastPushAt,
  readRemotes,
  rootCommits,
  setRemoteUrl,
  type AutoCommit,
  type Remote,
} from '../core/git';
import { compileGlobs } from '../core/glob';
import { withLock } from '../core/lock';
import { MissingFolderError } from '../core/process';
import { chooseRemote, redactCredentials, shortUrl } from '../core/remote';
import { addToGitignore, checkPending, stopTracking, type Finding } from '../core/safety';
import { FlightScheduler } from '../core/scheduler';
import { allowKey, belongsTo, repoKey, type AllowList, type WatchStore } from '../core/stores';
import type { Repository } from '../git/api';

export type FlightKind = 'auto' | 'manual';

/** Por qué no se puede hacer auto-commit ahora. */
export type BlockReason = 'untrusted' | 'conflicts' | 'detached' | 'noRemote';

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
  /** La carpeta del repo ya no existe. */
  onMissing(repo: RepoController): void;
  /** En la carpeta hay otro repo que el que se vigilaba: se dejó de vigilar. */
  onReplaced(repo: RepoController): void;
  /** Cómo revisar lo que se va a subir. */
  safety(): SafetyConfig;
  /** Avisos que el usuario marcó como falsos. */
  allowList: AllowList;
  /** Un vuelo automático no subió nada porque la revisión encontró algo. */
  onHeld(repo: RepoController, findings: readonly Finding[]): void;
  /** Subir a mano con algo encontrado: true si el usuario decide subir igual. */
  confirmHeld(repo: RepoController, findings: readonly Finding[]): Promise<boolean>;
}

/** A dónde sube el repo. */
export interface RemoteInfo {
  name: string;
  url: string;
}

export interface LastError {
  flight: Flight;
  at: number;
  /** A dónde subía cuando falló: si cambia, el error deja de importar. */
  remoteUrl: string | undefined;
}

/** Un repo que ya no está donde estaba. */
export interface LostFolder {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  /** 'missing': la carpeta no existe. 'notRepo': existe, pero ya no es un repo. */
  readonly reason: 'missing' | 'notRepo';
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
  private _remote: RemoteInfo | undefined;
  private _remoteNames: string[] = [];
  private _missing = false;
  private _nested: string[] = [];
  private _lastPushAt: number | undefined;
  private _lastAutoAt: number | undefined;
  private _lastError: LastError | undefined;
  private _held: readonly Finding[] | undefined;

  /** La lista de cambios cuando se frenó: sin cambios nuevos ni archivos guardados, no se vuelve a intentar. */
  private heldChanges: string | undefined;
  /** Qué se frenó la última vez, para no avisar dos veces lo mismo. */
  private heldFindings = '';
  /** Commits raíz; undefined hasta que se leen. Sin ellos no hay auto-commit. */
  private roots: string[] | undefined;
  private ignored: (relativePath: string) => boolean;
  private changeSignature = '';
  private headSignature = '';
  private remoteSignature: string | undefined;
  private upToDate: boolean | undefined;
  private disposed = false;
  private readonly scheduler: FlightScheduler;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly repo: Repository,
    private readonly services: RepoServices,
  ) {
    this.root = repo.rootUri;
    this.name = path.basename(repo.rootUri.fsPath);
    this.key = repoKey(repo.rootUri.fsPath);
    this._config = readRepoConfig(this.root);
    this.ignored = this.compileIgnored();
    this._watching = services.watchStore.get(this.key)?.on ?? this._config.autoStart;
    this.scheduler = new FlightScheduler(
      () => this.fly('auto'),
      this._config,
      (e) => services.log.error(`[${this.name}]`, e),
    );

    this.disposables.push(
      this.emitter,
      repo.state.onDidChange(() => this.sync()),
    );
    this.sync();
    void this.checkIdentity();
  }

  get config(): RepoConfig {
    return this._config;
  }
  get watching(): boolean {
    return this._watching;
  }
  get flying(): boolean {
    return this._flying;
  }
  /** Archivos con cambios, cuenten o no para el auto-commit. */
  get pending(): number {
    return this._pending;
  }
  /** Archivos con cambios que no están en apus.ignorePatterns. */
  get relevant(): number {
    return this._relevant;
  }
  get ahead(): number {
    return this._ahead;
  }
  get branch(): string | undefined {
    return this._branch;
  }
  get upstream(): string | undefined {
    return this._upstream;
  }
  get blocked(): BlockReason | undefined {
    return this._blocked;
  }
  /** El remoto al que sube apus, si se puede saber. */
  get remote(): RemoteInfo | undefined {
    return this._remote;
  }
  /** Todos los remotos. Puede haber remotos y no `remote`: varios, y ninguno es origin. */
  get remoteNames(): readonly string[] {
    return this._remoteNames;
  }
  /** La carpeta del repo ya no existe. */
  get missing(): boolean {
    return this._missing;
  }
  /** Repos que este tiene adentro y que git subiría como punteros vacíos. */
  get nested(): readonly string[] {
    return this._nested;
  }
  get nextFlightAt(): number | undefined {
    return this.scheduler.dueAt;
  }
  get lastPushAt(): number | undefined {
    return this._lastPushAt;
  }
  get lastAutoAt(): number | undefined {
    return this._lastAutoAt;
  }
  get lastError(): LastError | undefined {
    return this._lastError;
  }
  /** Lo que frenó la última subida: posibles secretos o archivos muy grandes. */
  get held(): readonly Finding[] | undefined {
    return this._held;
  }

  asLost(): LostFolder {
    return { key: this.key, path: this.root.fsPath, name: this.name, reason: 'missing' };
  }

  async setWatching(on: boolean): Promise<void> {
    this._watching = on;
    // Pausar o volver a vigilar es darse por enterado de un error viejo. Lo
    // frenado se vuelve a revisar en el próximo vuelo.
    this._lastError = undefined;
    this.clearHeld();
    const id = this.roots?.[0];
    await this.services.watchStore.set(this.key, id ? { on, id } : { on });
    this.services.log.info(`[${this.name}] ${on ? 'watching' : 'paused'}`);
    this.considerFlight(on);
    this.emitter.fire();
  }

  pushNow(): Promise<void> {
    return this.fly('manual');
  }

  /** El remoto al que sube, leído de git en este momento. */
  async readRemote(): Promise<(RemoteInfo & { separatePushUrl: boolean }) | undefined> {
    const remotes = await this.guard(() => readRemotes(this.services.gitPath, this.root.fsPath), []);
    const name = chooseRemote(
      remotes.map((r) => r.name),
      this._upstream?.split('/')[0],
    );
    const chosen = remotes.find((r) => r.name === name);
    const url = chosen && urlOf(chosen);
    return chosen && url
      ? { name: chosen.name, url, separatePushUrl: !!chosen.pushUrl && !!chosen.fetchUrl && chosen.pushUrl !== chosen.fetchUrl }
      : undefined;
  }

  /** Cambia la URL del remoto al que sube, o agrega origin si no tiene. */
  async setRemoteUrl(url: string): Promise<void> {
    const current = await this.readRemote();
    const name = current?.name ?? 'origin';
    await setRemoteUrl(this.services.gitPath, this.root.fsPath, {
      name,
      url,
      exists: current !== undefined,
      separatePushUrl: current?.separatePushUrl ?? false,
    });
    this.services.log.info(`[${this.name}] ${name}: ${current ? `${shortUrl(current.url)} → ` : ''}${shortUrl(url)}`);
    // vscode.git se entera solo, pero puede tardar: que la vista no muestre la URL vieja mientras tanto.
    this._remote = { name, url };
    this._remoteNames = [...new Set([...this._remoteNames, name])];
    this._lastError = undefined;
    if (this._blocked === 'noRemote') {
      this._blocked = undefined;
    }
    this.emitter.fire();
    await this.repo.status?.().catch(() => undefined);
  }

  /**
   * Lo que se frenaría si se subiera ahora. Vacío si la revisión está apagada.
   * Si git falla, el error sigue de largo: sin revisar, no se sube.
   */
  async checkPending(): Promise<Finding[]> {
    const safety = this.services.safety();
    if (!safety.enabled) {
      return [];
    }
    const { findings, partial } = await checkPending(this.services.gitPath, this.root.fsPath, {
      maxFileBytes: safety.maxFileBytes,
      isAllowed: (f) => this.services.allowList.has(this.key, f),
    });
    if (partial) {
      this.services.log.warn(`[${this.name}] too many changes to read them all: part of the content was not checked before pushing`);
    }
    return findings;
  }

  /** Vuelve a revisar, y actualiza lo frenado. */
  async recheck(): Promise<readonly Finding[]> {
    const findings = await this.guard(() => this.checkPending(), undefined);
    if (findings === undefined) {
      return this._held ?? [];
    }
    if (findings.length > 0) {
      this.hold(findings, false);
    } else if (this._held) {
      this.clearHeld();
      this.considerFlight(true);
    }
    this.emitter.fire();
    return findings;
  }

  /** Arreglos para lo frenado. Cada uno vuelve a revisar. */
  async ignoreFile(finding: Finding): Promise<void> {
    await addToGitignore(this.root.fsPath, finding.path);
    this.services.log.info(`[${this.name}] added to .gitignore: ${finding.path}`);
    await this.recheck();
  }

  async stopTracking(finding: Finding): Promise<void> {
    await stopTracking(this.services.gitPath, this.root.fsPath, finding.path);
    this.services.log.info(`[${this.name}] no longer tracked, and added to .gitignore: ${finding.path}`);
    await this.recheck();
  }

  /** Los avisos que se dejaron pasar en este repo. */
  allowed(): string[] {
    return this.services.allowList.list(this.key);
  }

  async forgetAllowed(keys: readonly string[]): Promise<void> {
    await this.services.allowList.remove(this.key, keys);
    this.services.log.info(`[${this.name}] checked again before pushing: ${keys.join(', ')}`);
    await this.recheck();
  }

  async allow(finding: Finding): Promise<void> {
    await this.services.allowList.add(this.key, finding);
    this.services.log.info(`[${this.name}] allowed: ${allowKey(finding)}`);
    await this.recheck();
  }

  /** Se guardó un archivo del repo: el repo no está quieto, la espera vuelve a empezar. */
  noteSave(): void {
    // Guardar puede haber sacado el secreto del archivo: que se vuelva a revisar.
    if (this._held) {
      this.heldChanges = undefined;
    }
    if (this.canAutoFly()) {
      this.scheduler.poke();
      this.emitter.fire();
    }
  }

  setNested(nested: string[]): void {
    if (nested.join('\n') !== this._nested.join('\n')) {
      this._nested = nested;
      this.emitter.fire();
    }
  }

  reloadConfig(): void {
    this._config = readRepoConfig(this.root);
    this.ignored = this.compileIgnored();
    this._watching = this.services.watchStore.get(this.key)?.on ?? this._config.autoStart;
    this.scheduler.setOptions(this._config);
    this.changeSignature = '';
    this.sync();
  }

  autoCommits(): Promise<AutoCommit[]> {
    return this.guard(() => autoCommits(this.services.gitPath, this.root.fsPath, this._config.logSize), []);
  }

  /** URL navegable del remoto, si es un host web. */
  browseUrl(): string | undefined {
    return this._remote ? browseUrl(this._remote.url) : undefined;
  }

  /** Recalcula todo desde el estado que mantiene vscode.git. */
  sync(): void {
    if (this.disposed) {
      return;
    }
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

    this._remoteNames = state.remotes.map((r) => r.name);
    const chosen = state.remotes.find((r) => r.name === chooseRemote(this._remoteNames, head?.upstream?.remote));
    // vscode.git lee .git/config tal cual, donde "\" se escribe "\\": una ruta de Windows llega con las barras dobles.
    const url = chosen && urlOf(chosen)?.replaceAll('\\\\', '\\');
    this._remote = chosen && url ? { name: chosen.name, url } : undefined;

    this._blocked = !vscode.workspace.isTrusted
      ? 'untrusted'
      : state.mergeChanges.length > 0
        ? 'conflicts'
        : head && !head.name
          ? 'detached'
          : state.remotes.length === 0
            ? 'noRemote'
            : undefined;

    // Un error viejo deja de importar cuando el repo pasa a estar limpio y al
    // día (por ejemplo, subiste desde la terminal), o cuando cambia a dónde
    // sube. Tiene que ser un cambio: justo después de un vuelo, vscode.git
    // puede no haber visto todavía el commit y parecer al día.
    const upToDate = this._pending === 0 && this._ahead === 0 && this._upstream !== undefined;
    const remoteSignature = `${this._remote?.name} ${this._remote?.url}`;
    if (this._lastError && !this._flying) {
      if (upToDate && this.upToDate === false) {
        this._lastError = undefined;
      } else if (this.remoteSignature !== undefined && remoteSignature !== this.remoteSignature) {
        void this.dropErrorIfRemoteChanged();
      }
    }
    this.upToDate = upToDate;
    this.remoteSignature = remoteSignature;

    const headSignature = `${head?.commit}|${this._upstream}|${this._ahead}`;
    if (headSignature !== this.headSignature) {
      this.headSignature = headSignature;
      void this.refreshHistory();
    }

    // vscode.git avisa aunque no haya nada nuevo (por ejemplo, al volver a la
    // ventana): solo un cambio real en la lista reinicia la espera.
    const changeSignature = relevant
      .map((p) => `${status.get(p)} ${p}`)
      .sort()
      .join('\n');
    const changed = changeSignature !== this.changeSignature;
    this.changeSignature = changeSignature;
    this.considerFlight(changed);
    this.emitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.scheduler.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * vscode.git puede tardar en ver un cambio de URL: la que vale es la de git.
   * Si todavía es a la que subía cuando falló, el error sigue en pie.
   */
  private async dropErrorIfRemoteChanged(): Promise<void> {
    const error = this._lastError;
    const url = (await this.readRemote())?.url;
    if (error && this._lastError === error && url !== error.remoteUrl) {
      this._lastError = undefined;
      this.emitter.fire();
    }
  }

  private canAutoFly(): boolean {
    const stillHeld = this._held !== undefined && this.heldChanges === this.changeSignature;
    return this._watching && this.roots !== undefined && !this._missing && !this._blocked && !stillHeld && this._relevant > 0;
  }

  private hold(findings: readonly Finding[], notify: boolean): void {
    const signature = findings.map(allowKey).sort().join('\n');
    const isNew = signature !== this.heldFindings;
    this._held = findings;
    this.heldChanges = this.changeSignature;
    this.heldFindings = signature;
    this.scheduler.cancel();
    if (isNew) {
      this.services.log.warn(
        `[${this.name}] held back: ${findings.map((f) => `${f.path} (${f.rule}${f.line ? `, line ${f.line}` : ''}${f.commit ? `, commit ${f.commit}` : ''})`).join(', ')}`,
      );
      if (notify) {
        this.services.onHeld(this, findings);
      }
    }
  }

  private clearHeld(): void {
    this._held = undefined;
    this.heldChanges = undefined;
    this.heldFindings = '';
  }

  private considerFlight(restart: boolean): void {
    if (!this.canAutoFly()) {
      this.scheduler.cancel();
    } else if (restart || this.scheduler.dueAt === undefined) {
      this.scheduler.poke();
    }
  }

  /**
   * Si en esta carpeta ahora hay otro repo que el que vigilabas (borraste uno y
   * clonaste otro en el mismo lugar), la vigilancia no pasa sola al nuevo.
   */
  private async checkIdentity(): Promise<void> {
    const { gitPath, log, watchStore } = this.services;
    const roots = await this.guard(() => rootCommits(gitPath, this.root.fsPath), []);
    if (this.disposed || this._missing) {
      return;
    }
    this.roots = roots;
    const entry = watchStore.get(this.key);
    if (entry && !belongsTo(entry, roots)) {
      log.warn(`[${this.name}] this folder now holds a different repository than the one you watched: watching reset`);
      await watchStore.set(this.key, undefined);
      this._watching = this._config.autoStart;
      if (entry.on && !this._watching) {
        this.services.onReplaced(this);
      }
    } else if (entry && !entry.id && roots[0]) {
      await watchStore.set(this.key, { on: entry.on, id: roots[0] });
    }
    this.sync();
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
      this._watching = this.services.watchStore.get(this.key)?.on ?? this._config.autoStart;
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
      // Antes de subir, mirar qué se sube. Lo automático no sube nada si
      // aparece algo; lo manual pregunta.
      const findings = await this.checkPending();
      if (findings.length > 0) {
        if (kind === 'auto') {
          this.hold(findings, true);
          return;
        }
        if (!(await this.services.confirmHeld(this, findings))) {
          this.hold(findings, false);
          return;
        }
        log.warn(`[${this.name}] pushing anyway, by hand: ${findings.map((f) => `${f.path} (${f.rule})`).join(', ')}`);
      }
      this.clearHeld();

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
        return flyApus(binary, this.root.fsPath, { message, background: kind === 'auto' });
      });

      if (!result.acquired) {
        log.info(`[${this.name}] another process is pushing this repo${result.holder ? ` (pid ${result.holder.pid})` : ''}`);
        if (kind === 'manual') {
          void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: another window is pushing this repo.', this.name));
        }
        return;
      }
      if (result.value) {
        const remoteUrl = result.value.ok ? undefined : (await this.readRemote())?.url;
        this.report(kind, result.value, changes, remoteUrl);
      }
    } catch (e) {
      if (e instanceof MissingFolderError) {
        this.markMissing();
        return;
      }
      const summary = redactCredentials(e instanceof Error ? e.message : String(e));
      this.report(
        kind,
        { code: -1, ok: false, summary, detail: undefined, committed: false, pushed: false, output: summary },
        changes,
        this._remote?.url,
      );
    } finally {
      this._flying = false;
      if (!this.disposed && !this._missing) {
        await this.refreshHistory();
        this.sync();
      } else if (!this.disposed) {
        this.emitter.fire();
      }
    }
  }

  private report(kind: FlightKind, flight: Flight, changes: number, remoteUrl: string | undefined): void {
    const { log } = this.services;
    if (flight.output) {
      log.info(`[${this.name}]\n${flight.output}`);
    }
    let repeated = false;
    if (flight.ok) {
      this._lastError = undefined;
    } else {
      repeated = this._lastError?.flight.summary === flight.summary && this._lastError?.flight.code === flight.code;
      this._lastError = { flight, at: Date.now(), remoteUrl };
      log.warn(`[${this.name}] apus exited with code ${flight.code}`);
    }
    this.services.onFlight({ repo: this, kind, flight, changes }, repeated);
  }

  private async refreshHistory(): Promise<void> {
    const { gitPath } = this.services;
    await this.guard(async () => {
      const [push, auto] = await Promise.all([
        this._upstream ? lastPushAt(gitPath, this.root.fsPath, this._upstream) : Promise.resolve(undefined),
        lastAutoCommitAt(gitPath, this.root.fsPath),
      ]);
      if (this.disposed) {
        return;
      }
      this._lastPushAt = push;
      this._lastAutoAt = auto;
      if (auto !== undefined) {
        this.scheduler.noteFlight(auto);
      }
      this.emitter.fire();
    }, undefined);
  }

  /** Corre algo contra git. Si la carpeta desapareció lo anota; otros errores van al registro. */
  private async guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MissingFolderError) {
        this.markMissing();
      } else {
        this.services.log.warn(`[${this.name}] git failed:`, redactCredentials(e instanceof Error ? e.message : String(e)));
      }
      return fallback;
    }
  }

  private markMissing(): void {
    if (this._missing || this.disposed) {
      return;
    }
    this._missing = true;
    this.scheduler.cancel();
    this.services.log.warn(`[${this.name}] the folder no longer exists: ${this.root.fsPath}`);
    this.services.onMissing(this);
    this.emitter.fire();
  }

  private compileIgnored(): (relativePath: string) => boolean {
    return compileGlobs(this._config.ignorePatterns, (pattern, error) =>
      this.services.log.warn(`[${this.name}] apus.ignorePatterns: skipping "${pattern}": ${error.message}`),
    );
  }
}

function urlOf(remote: Remote): string | undefined {
  return remote.pushUrl ?? remote.fetchUrl;
}
