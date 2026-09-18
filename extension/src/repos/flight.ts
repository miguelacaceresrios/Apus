// Un vuelo: add + commit + push con apus, con el candado del repo tomado para
// que dos ventanas no suban a la vez.

import * as path from 'node:path';
import { autoMessage, flyApus, type Flight } from '../core/apus';
import { absoluteGitDir, changedFiles, lastAutoCommitAt } from '../core/git';
import { withLock } from '../core/lock';
import type { FlightKind } from './types';

export type LaunchResult =
  | { kind: 'flown'; flight: Flight }
  /** Otro proceso (otra ventana de VS Code) tiene el candado del repo. */
  | { kind: 'busy'; pid: number | undefined }
  /** Otro auto-commit fue hace menos que apus.minInterval, quizás desde otra ventana. */
  | { kind: 'tooSoon'; secondsAgo: number };

export interface LaunchOptions {
  git: string;
  root: string;
  binary: string;
  kind: FlightKind;
  /** Mínimo entre dos auto-commits. 0 al reintentar un push que falló sin conexión. */
  minGapMs: number;
  messageTemplate: string;
}

export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const { git, root, binary, kind } = options;
  const gitDir = await absoluteGitDir(git, root);
  const result = await withLock(path.join(gitDir, 'apus.lock'), async (): Promise<LaunchResult> => {
    if (kind === 'auto' && options.minGapMs > 0) {
      const last = await lastAutoCommitAt(git, root);
      if (last !== undefined && Date.now() - last < options.minGapMs) {
        return { kind: 'tooSoon', secondsAgo: Math.round((Date.now() - last) / 1000) };
      }
    }
    // Los archivos se leen con el candado tomado: son los que va a commitear apus.
    const message = kind === 'auto' ? autoMessage(options.messageTemplate, new Date(), await changedFiles(git, root)) : undefined;
    return { kind: 'flown', flight: await flyApus(binary, root, { message, background: kind === 'auto' }) };
  });
  return result.acquired ? result.value : { kind: 'busy', pid: result.holder?.pid };
}
