// La foto de un repo, sacada del estado que mantiene vscode.git. No hace nada
// con ella: el controlador decide qué cambió y qué hacer.

import * as path from 'node:path';
import { chooseRemote } from '../core/remote';
import type { RepositoryState } from '../git/api';
import type { BlockReason, RemoteInfo } from './types';

export interface RepoSnapshot {
  /** Archivos con cambios, cuenten o no para el auto-commit. */
  pending: number;
  /** Archivos con cambios que no están en apus.ignorePatterns. */
  relevant: number;
  branch: string | undefined;
  upstream: string | undefined;
  ahead: number;
  remoteNames: string[];
  /** El remoto al que sube apus, si se puede saber. */
  remote: RemoteInfo | undefined;
  blocked: BlockReason | undefined;
  /** Limpio y al día con su rama remota. */
  upToDate: boolean;
  /** Los cambios que cuentan, con su estado: si no cambia, no hubo cambios nuevos. */
  changeSignature: string;
  /** El commit, la rama remota y lo que falta subir: si cambia, hay historia nueva que leer. */
  headSignature: string;
}

export function snapshot(state: RepositoryState, root: string, ignored: (relativePath: string) => boolean, trusted: boolean): RepoSnapshot {
  const status = new Map<string, number>();
  for (const change of [...state.mergeChanges, ...state.indexChanges, ...state.workingTreeChanges, ...(state.untrackedChanges ?? [])]) {
    status.set(change.uri.fsPath, change.status);
  }
  const relevant = [...status.keys()].filter((p) => !ignored(path.relative(root, p)));

  const head = state.HEAD;
  const upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
  const ahead = head?.ahead ?? 0;

  const remoteNames = state.remotes.map((r) => r.name);
  const chosen = state.remotes.find((r) => r.name === chooseRemote(remoteNames, head?.upstream?.remote));
  // vscode.git lee .git/config tal cual, donde "\" se escribe "\\": una ruta de Windows llega con las barras dobles.
  const url = (chosen?.pushUrl ?? chosen?.fetchUrl)?.replaceAll('\\\\', '\\');

  const blocked: BlockReason | undefined = !trusted
    ? 'untrusted'
    : state.mergeChanges.length > 0
      ? 'conflicts'
      : head && !head.name
        ? 'detached'
        : state.remotes.length === 0
          ? 'noRemote'
          : undefined;

  return {
    pending: status.size,
    relevant: relevant.length,
    branch: head?.name,
    upstream,
    ahead,
    remoteNames,
    remote: chosen && url ? { name: chosen.name, url } : undefined,
    blocked,
    upToDate: status.size === 0 && ahead === 0 && upstream !== undefined,
    changeSignature: relevant
      .map((p) => `${status.get(p)} ${p}`)
      .sort()
      .join('\n'),
    headSignature: `${head?.commit}|${upstream}|${ahead}`,
  };
}
