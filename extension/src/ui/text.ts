// Textos que se arman en más de un lugar. Todo pasa por vscode.l10n.t: el
// original está en inglés y las traducciones viven en l10n/.

import * as vscode from 'vscode';
import type { Flight } from '../core/apus';
import { APUS_EXE, type BinaryProblem } from '../core/binary';
import { formatClock, formatRelative } from '../core/time';
import type { BlockReason } from '../repos/repoController';

export const locale = (): string => vscode.env.language;

export const clock = (ms: number): string => formatClock(ms, locale());

/** "10:48 (hace 5 min)". */
export const when = (ms: number): string => `${clock(ms)} (${formatRelative(ms, locale())})`;

export function changes(n: number): string {
  return n === 1 ? vscode.l10n.t('1 change') : vscode.l10n.t('{0} changes', n);
}

export function uncommitted(n: number): string {
  return n === 1 ? vscode.l10n.t('1 uncommitted change') : vscode.l10n.t('{0} uncommitted changes', n);
}

export function unpushed(n: number): string {
  return n === 1 ? vscode.l10n.t('1 unpushed commit') : vscode.l10n.t('{0} unpushed commits', n);
}

export function reposWithChanges(n: number): string {
  return n === 1 ? vscode.l10n.t('1 repo with unpushed changes') : vscode.l10n.t('{0} repos with unpushed changes', n);
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return vscode.l10n.t('{0} s', s);
  }
  const m = Math.round(s / 60);
  return m < 60 ? vscode.l10n.t('{0} min', m) : vscode.l10n.t('{0} h', Math.round(m / 6) / 10);
}

/** Lo que dijo apus, o una explicación del código si no dijo nada. */
export function flightSummary(flight: Flight): string {
  if (flight.summary) {
    return flight.summary;
  }
  return flight.code === -1 ? vscode.l10n.t('apus did not finish in time') : vscode.l10n.t('apus exited with code {0}', flight.code);
}

export function binaryProblem(problem: BinaryProblem, path = ''): string {
  switch (problem) {
    case 'notOnPath':
      return vscode.l10n.t('{0} is not on the PATH', APUS_EXE);
    case 'notAbsolute':
      return vscode.l10n.t('apus.path must be an absolute path (it is "{0}")', path);
    case 'windowBinary':
      return vscode.l10n.t('apusw.exe is the windowed build of apus: point apus.path to apus.exe');
    case 'notExe':
      return vscode.l10n.t('apus.path must point to an .exe file');
    case 'missing':
      return vscode.l10n.t('apus.path points to {0}, which does not exist or is not executable', path);
  }
}

export function blockReason(reason: BlockReason): string {
  switch (reason) {
    case 'untrusted':
      return vscode.l10n.t('the workspace is not trusted');
    case 'conflicts':
      return vscode.l10n.t('there are unresolved conflicts');
    case 'detached':
      return vscode.l10n.t('HEAD is detached');
  }
}
