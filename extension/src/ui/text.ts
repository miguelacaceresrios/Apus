// Textos que se arman en más de un lugar. Todo pasa por vscode.l10n.t: el
// original está en inglés y las traducciones viven en l10n/.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Flight, Trouble } from '../core/apus';
import { APUS_EXE, type BinaryProblem } from '../core/binary';
import { shortUrl, type UrlCheck } from '../core/remote';
import { formatClock, formatRelative } from '../core/time';
import type { BlockReason, LostFolder, RepoController } from '../repos/repoController';

export const locale = (): string => vscode.env.language;

export const clock = (ms: number): string => formatClock(ms, locale());

/** "10:48 (hace 5 min)". */
export const when = (ms: number): string => `${clock(ms)} (${formatRelative(ms, locale())})`;

/** La ruta con ~ en lugar de la carpeta del usuario: "~\Desktop\viper". */
export function tildify(fsPath: string): string {
  const home = os.homedir();
  const same = process.platform === 'win32'
    ? fsPath.toLowerCase().startsWith(home.toLowerCase() + path.sep)
    : fsPath.startsWith(home + path.sep);
  return same ? `~${fsPath.slice(home.length)}` : fsPath;
}

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
    case 'noRemote':
      return vscode.l10n.t('no URL to push to');
  }
}

export function lostReason(entry: LostFolder): string {
  return entry.reason === 'missing' ? vscode.l10n.t('folder not found') : vscode.l10n.t('no longer a git repository');
}

/** El botón que arregla un error reconocido, si hay uno. */
export function fixLabel(trouble: Trouble | undefined): string | undefined {
  switch (trouble) {
    case 'noRemote':
      return vscode.l10n.t('Connect URL…');
    case 'remoteNotFound':
      return vscode.l10n.t('Change URL…');
    case 'behind':
      return vscode.l10n.t('Open Terminal');
    default:
      return undefined;
  }
}

/** El error explicado para una persona, cuando apus solo no alcanza. */
export function troubleText(trouble: Trouble | undefined, repo: RepoController, flight: Flight): string {
  switch (trouble) {
    case 'noRemote':
      return vscode.l10n.t('there is no URL to push to yet');
    case 'remoteNotFound':
      return repo.remote
        ? vscode.l10n.t('{0} was not found. Was the repository deleted or renamed?', shortUrl(repo.remote.url))
        : vscode.l10n.t('the repository to push to was not found. Was it deleted or renamed?');
    default: {
      const summary = flightSummary(flight);
      return flight.detail ? `${summary}. ${flight.detail}` : summary;
    }
  }
}

/** El mensaje de validación del cuadro de la URL. */
export function urlMessage(check: UrlCheck): vscode.InputBoxValidationMessage | undefined {
  if (check.ok) {
    return undefined;
  }
  if (check.problem === 'empty') {
    return { message: vscode.l10n.t('Paste the URL of the repository, for example https://github.com/user/repo.git'), severity: vscode.InputBoxValidationSeverity.Info };
  }
  return {
    message: check.suggestion
      ? vscode.l10n.t('Missing https:// at the start? Try {0}', check.suggestion)
      : vscode.l10n.t('That does not look like a repository URL. Example: https://github.com/user/repo.git'),
    severity: vscode.InputBoxValidationSeverity.Error,
  };
}
