import * as path from 'node:path';
import * as vscode from 'vscode';
import { readRepoConfig, type RepoConfig } from '../config';
import { diagnose, type Flight } from '../core/apus';
import { autoCommits, browseUrl, lastAutoCommitAt, lastPushAt, readRemotes, rootCommits, setRemoteUrl, type AutoCommit } from '../core/git';
import { compileGlobs } from '../core/glob';
import { HeldBack } from '../core/held';
import { MissingFolderError } from '../core/process';
import { chooseRemote, redactCredentials, shortUrl } from '../core/remote';
import { addToGitignore, checkPending, stopTracking, type Finding } from '../core/safety';
import { FlightScheduler, retryDelayMs } from '../core/scheduler';
import { commitSigning, signsQuietly } from '../core/signing';
import { allowKey, belongsTo, repoKey } from '../core/stores';
import type { Repository } from '../git/api';
import { launch } from './flight';
import { snapshot, type RepoSnapshot } from './state';
import type { BlockReason, FlightKind, LastError, LostFolder, RemoteInfo, RepoServices } from './types';

const EMPTY: RepoSnapshot = {
  pending: 0,
  relevant: 0,
  branch: undefined,
  upstream: undefined,
  ahead: 0,
  remoteNames: [],
  remote: undefined,
  blocked: undefined,
  upToDate: false,
  changeSignature: '',
  headSignature: '',
};

/** Un auto-commit que no se intentó: firmar habría abierto la ventana de la contraseña de GPG. */
const NEEDS_PASSPHRASE: Flight = {
  code: -1,
  ok: false,
  summary: undefined,
  detail: undefined,
  committed: false,
  pushed: false,
  reason: 'signing',
  output: 'gpg needs the passphrase to sign the commit, and it is not cached',
};

/** Un repo: su estado, su vigilancia y sus vuelos. */
export class RepoController implements vscode.Disposable {
  readonly root: vscode.Uri;
  readonly name: string;
  readonly key: string;

  private _config: RepoConfig;
  private _watching: boolean;
  private _flying = false;
  private _missing = false;
  private _nested: string[] = [];
  private _lastPushAt: number | undefined;
  private _lastAutoAt: number | undefined;
  private _lastError: LastError | undefined;
  /** Sin conexión: el próximo intento de subir, y cuántos van. */
  private retry: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
  private offlineAttempts = 0;

  /** La última foto del estado de vscode.git. */
  private state = EMPTY;
  /** Lo que frenó la revisión antes de subir. */
  private readonly heldBack = new HeldBack();
  /** Commits raíz; undefined hasta que se leen. Sin ellos no hay auto-commit. */
  private roots: string[] | undefined;
  private ignored: (relativePath: string) => boolean;
  /** Lo visto en la sincronización anterior, para saber qué cambió. */
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
    return this.state.pending;
  }
  /** Archivos con cambios que no están en apus.ignorePatterns. */
  get relevant(): number {
    return this.state.relevant;
  }
  get ahead(): number {
    return this.state.ahead;
  }
  get branch(): string | undefined {
    return this.state.branch;
  }
  get upstream(): string | undefined {
    return this.state.upstream;
  }
  get blocked(): BlockReason | undefined {
    return this.state.blocked;
  }
  /** El remoto al que sube apus, si se puede saber. */
  get remote(): RemoteInfo | undefined {
    return this.state.remote;
  }
  /** Todos los remotos. Puede haber remotos y no `remote`: varios, y ninguno es origin. */
  get remoteNames(): readonly string[] {
    return this.state.remoteNames;
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
  /** El último push falló porque no se pudo llegar al remoto. No es algo para arreglar: se reintenta solo. */
  get offline(): boolean {
    return this._lastError?.trouble === 'offline';
  }
  /** Cuándo se vuelve a intentar subir, si está sin conexión y vigilando. */
  get retryAt(): number | undefined {
    return this.retry?.at;
  }
  /** Lo que frenó la última subida: posibles secretos o archivos muy grandes. */
  get held(): readonly Finding[] | undefined {
    return this.heldBack.findings;
  }

  asLost(): LostFolder {
    return { key: this.key, path: this.root.fsPath, name: this.name, reason: 'missing' };
  }

  async setWatching(on: boolean): Promise<void> {
    this._watching = on;
    // Pausar o volver a vigilar es darse por enterado de un error viejo. Lo
    // frenado se vuelve a revisar en el próximo vuelo.
    this.clearError();
    this.heldBack.clear();
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
      this.state.upstream?.split('/')[0],
    );
    const chosen = remotes.find((r) => r.name === name);
    const url = chosen?.pushUrl ?? chosen?.fetchUrl;
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
    this.state = {
      ...this.state,
      remote: { name, url },
      remoteNames: [...new Set([...this.state.remoteNames, name])],
      blocked: this.state.blocked === 'noRemote' ? undefined : this.state.blocked,
    };
    this.clearError();
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
      return this.held ?? [];
    }
    if (findings.length > 0) {
      this.hold(findings, false);
    } else if (this.held) {
      this.heldBack.clear();
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
    this.heldBack.noteSave();
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
    return this.state.remote ? browseUrl(this.state.remote.url) : undefined;
  }

  /** Recalcula todo desde el estado que mantiene vscode.git. */
  sync(): void {
    if (this.disposed) {
      return;
    }
    const next = snapshot(this.repo.state, this.root.fsPath, this.ignored, vscode.workspace.isTrusted);
    this.state = next;

    // Un error viejo deja de importar cuando el repo pasa a estar limpio y al
    // día (por ejemplo, subiste desde la terminal), o cuando cambia a dónde
    // sube. Tiene que ser un cambio: justo después de un vuelo, vscode.git
    // puede no haber visto todavía el commit y parecer al día.
    const remoteSignature = `${next.remote?.name} ${next.remote?.url}`;
    if (this._lastError && !this._flying) {
      if (next.upToDate && this.upToDate === false) {
        this.clearError();
      } else if (this.remoteSignature !== undefined && remoteSignature !== this.remoteSignature) {
        void this.dropErrorIfRemoteChanged();
      }
    }
    this.upToDate = next.upToDate;
    this.remoteSignature = remoteSignature;

    if (next.headSignature !== this.headSignature) {
      this.headSignature = next.headSignature;
      void this.refreshHistory();
    }

    // vscode.git avisa aunque no haya nada nuevo (por ejemplo, al volver a la
    // ventana): solo un cambio real en la lista reinicia la espera.
    const changed = next.changeSignature !== this.changeSignature;
    this.changeSignature = next.changeSignature;
    this.considerFlight(changed);
    this.emitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetry();
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
      this.clearError();
      this.emitter.fire();
    }
  }

  /** El error dejó de importar: se sube bien, se pausó o cambió a dónde sube. */
  private clearError(): void {
    this._lastError = undefined;
    this.offlineAttempts = 0;
    this.cancelRetry();
  }

  /**
   * Sin conexión, el commit quedó hecho pero no subió. Se vuelve a intentar
   * solo, cada vez más espaciado, mientras siga vigilando.
   */
  private scheduleRetry(): void {
    this.cancelRetry();
    if (!this._watching || this.disposed || this._missing) {
      return;
    }
    const delay = retryDelayMs(this.offlineAttempts++);
    const timer = setTimeout(() => {
      this.retry = undefined;
      // Si ya viene un auto-commit, ese sube todo: se espera un poco más.
      if (this.scheduler.dueAt !== undefined) {
        this.scheduleRetry();
      } else if (this.offline) {
        void this.fly('auto', true);
      }
      this.emitter.fire();
    }, delay);
    this.retry = { at: Date.now() + delay, timer };
  }

  private cancelRetry(): void {
    if (this.retry) {
      clearTimeout(this.retry.timer);
      this.retry = undefined;
    }
  }

  private canAutoFly(): boolean {
    return this.canRetry() && this.state.relevant > 0;
  }

  /** Lo mismo que un auto-commit, sin necesitar cambios nuevos: hay commits por subir. */
  private canRetry(): boolean {
    return (
      this._watching && this.roots !== undefined && !this._missing && !this.state.blocked && !this.heldBack.blocks(this.changeSignature)
    );
  }

  private hold(findings: readonly Finding[], notify: boolean): void {
    this.scheduler.cancel();
    if (!this.heldBack.hold(findings, this.changeSignature)) {
      return;
    }
    const detail = (f: Finding) => `${f.path} (${f.rule}${f.line ? `, line ${f.line}` : ''}${f.commit ? `, commit ${f.commit}` : ''})`;
    this.services.log.warn(`[${this.name}] held back: ${findings.map(detail).join(', ')}`);
    if (notify) {
      this.services.onHeld(this, findings);
    }
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

  /** `retry`: un reintento después de fallar sin conexión. Sube lo pendiente aunque no haya cambios nuevos. */
  private async fly(kind: FlightKind, retry = false): Promise<void> {
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
      if (!(retry ? this.canRetry() : this.canAutoFly())) {
        this.emitter.fire();
        return;
      }
    }

    const binary = await this.services.binary(kind === 'manual');
    if (!binary) {
      return;
    }

    const changes = this.state.pending;
    this._flying = true;
    this.emitter.fire();
    try {
      if (!(await this.clearedForTakeoff(kind))) {
        return;
      }
      if (kind === 'auto' && !(await this.signsQuietly())) {
        log.warn(`[${this.name}] commits are signed with GPG and its passphrase is not cached: push by hand once`);
        this.report(kind, NEEDS_PASSPHRASE, changes, this.state.remote?.url);
        return;
      }
      log.info(`[${this.name}] ${retry ? 'retrying the push' : kind === 'auto' ? 'auto-commit' : 'manual push'} with ${binary}`);
      const result = await launch({
        git: this.services.gitPath,
        root: this.root.fsPath,
        binary,
        kind,
        minGapMs: retry ? 0 : this._config.minGapMs,
        messageTemplate: this._config.messageTemplate,
      });
      switch (result.kind) {
        case 'busy':
          log.info(`[${this.name}] another process is pushing this repo${result.pid ? ` (pid ${result.pid})` : ''}`);
          if (kind === 'manual') {
            void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: another window is pushing this repo.', this.name));
          } else if (retry) {
            this.scheduleRetry();
          }
          break;
        case 'tooSoon':
          log.info(`[${this.name}] auto-commit skipped: the last one was ${result.secondsAgo} s ago`);
          break;
        case 'flown': {
          const remoteUrl = result.flight.ok ? undefined : (await this.readRemote())?.url;
          this.report(kind, result.flight, changes, remoteUrl);
          break;
        }
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
        this.state.remote?.url,
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

  /** Antes de subir, mirar qué se sube. Lo automático no sube nada si aparece algo; lo manual pregunta. */
  private async clearedForTakeoff(kind: FlightKind): Promise<boolean> {
    const findings = await this.checkPending();
    if (findings.length > 0) {
      if (kind === 'auto') {
        this.hold(findings, true);
        return false;
      }
      if (!(await this.services.confirmHeld(this, findings))) {
        this.hold(findings, false);
        return false;
      }
      this.services.log.warn(`[${this.name}] pushing anyway, by hand: ${findings.map((f) => `${f.path} (${f.rule})`).join(', ')}`);
    }
    this.heldBack.clear();
    return true;
  }

  private report(kind: FlightKind, flight: Flight, changes: number, remoteUrl: string | undefined): void {
    const { log } = this.services;
    if (flight.output) {
      log.info(`[${this.name}]\n${flight.output}`);
    }
    let repeated = false;
    if (flight.ok) {
      this.clearError();
    } else {
      const trouble = diagnose(flight);
      repeated = this._lastError?.flight.summary === flight.summary && this._lastError?.flight.code === flight.code;
      this._lastError = { flight, trouble, at: Date.now(), remoteUrl };
      log.warn(`[${this.name}] apus exited with code ${flight.code}${flight.reason ? ` (${flight.reason})` : ''}`);
      if (trouble === 'offline') {
        this.scheduleRetry();
        if (this.retry) {
          log.info(`[${this.name}] no connection: trying again in ${Math.round((this.retry.at - Date.now()) / 60_000)} min`);
        }
      } else {
        this.offlineAttempts = 0;
        this.cancelRetry();
      }
    }
    this.services.onFlight({ repo: this, kind, flight, changes }, repeated);
  }

  /** Si los commits se firman, que se pueda sin abrir la ventana de la contraseña. */
  private async signsQuietly(): Promise<boolean> {
    const signing = await commitSigning(this.services.gitPath, this.root.fsPath);
    return !signing || (await signsQuietly(signing, this.root.fsPath));
  }

  private async refreshHistory(): Promise<void> {
    const { gitPath } = this.services;
    await this.guard(async () => {
      const upstream = this.state.upstream;
      const [push, auto] = await Promise.all([
        upstream ? lastPushAt(gitPath, this.root.fsPath, upstream) : Promise.resolve(undefined),
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
    this.cancelRetry();
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
