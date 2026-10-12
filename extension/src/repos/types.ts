import type * as vscode from 'vscode';
import type { SafetyConfig } from '../config';
import type { Flight, Trouble } from '../core/apus';
import type { Finding } from '../core/safety';
import type { AllowList, WatchStore } from '../core/stores';
import type { RepoController } from './repoController';

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

/** Lo que un repo necesita de afuera: git, apus, lo guardado y cómo avisar. */
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
  /** Qué fue, si se reconoce. */
  trouble: Trouble | undefined;
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
