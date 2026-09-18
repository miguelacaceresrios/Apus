// Cómo se cuenta el estado de un repo. La barra, la vista y el menú usan lo mismo.

import * as vscode from 'vscode';
import { shortUrl } from '../core/remote';
import { formatCountdown } from '../core/time';
import type { RepoController } from '../repos/repoController';
import { heldState, heldSummary } from './safety';
import { blockReason, changes, clock, flightSummary, tildify, uncommitted, unpushed, when } from './text';

/** Ícono propio, definido en package.json (contributes.icons) con images/apus-icons.woff. */
export const LOGO = 'apus-logo';

/** Comandos que se pueden disparar desde los links de un tooltip. */
const TOOLTIP_COMMANDS = [
  'apus.toggleWatch',
  'apus.pushNow',
  'apus.showLog',
  'apus.fixBinary',
  'apus.getStarted',
  'apus.changeUrl',
  'apus.changeFolder',
  'apus.fixLast',
  'apus.relocate',
  'apus.reviewHeld',
];

export interface Look {
  icon: string;
  color: string | undefined;
  state: string;
}

export function look(c: RepoController): Look {
  if (c.missing) {
    return { icon: 'warning', color: 'problemsWarningIcon.foreground', state: vscode.l10n.t('folder not found') };
  }
  if (c.flying) {
    return { icon: 'sync~spin', color: undefined, state: vscode.l10n.t('pushing…') };
  }
  if (c.held) {
    return { icon: 'shield', color: 'problemsWarningIcon.foreground', state: heldState(c.held) };
  }
  if (c.offline) {
    return { icon: 'cloud', color: undefined, state: vscode.l10n.t('no connection') };
  }
  if (c.lastError) {
    return { icon: 'warning', color: 'problemsWarningIcon.foreground', state: vscode.l10n.t('last push failed') };
  }
  if (!c.watching) {
    return c.blocked === 'noRemote'
      ? { icon: 'debug-disconnect', color: undefined, state: vscode.l10n.t('no URL') }
      : { icon: 'eye-closed', color: undefined, state: vscode.l10n.t('paused') };
  }
  if (c.blocked === 'noRemote') {
    return { icon: 'debug-disconnect', color: 'problemsWarningIcon.foreground', state: vscode.l10n.t('watching, but there is no URL') };
  }
  if (c.blocked) {
    return { icon: 'circle-slash', color: 'problemsWarningIcon.foreground', state: vscode.l10n.t('stopped: {0}', blockReason(c.blocked)) };
  }
  return { icon: LOGO, color: 'charts.orange', state: vscode.l10n.t('watching') };
}

/** Si el estado pide que hagas algo: se pinta de advertencia. Sin conexión no: se reintenta solo. */
export function needsAttention(c: RepoController): boolean {
  return c.missing || c.held !== undefined || (c.lastError !== undefined && !c.offline) || (c.watching && c.blocked === 'noRemote');
}

/** "en 1:40": lo que falta para el próximo auto-commit o, sin conexión, para el próximo intento. */
export function countdown(c: RepoController, now = Date.now()): string | undefined {
  const at = c.nextFlightAt ?? c.retryAt;
  return at !== undefined && !c.flying ? vscode.l10n.t('in {0}', formatCountdown(at - now)) : undefined;
}

/** Una línea corta para la vista: "vigilando · 3 cambios · en 1:40". */
export function summary(c: RepoController): string {
  const parts = [look(c).state];
  if (c.missing) {
    return parts[0]!;
  }
  if (c.pending > 0) {
    parts.push(changes(c.pending));
  }
  if (c.ahead > 0) {
    parts.push(vscode.l10n.t('{0} unpushed', c.ahead));
  }
  const next = countdown(c);
  if (next) {
    parts.push(next);
  } else if (c.lastPushAt !== undefined) {
    parts.push(vscode.l10n.t('pushed {0}', clock(c.lastPushAt)));
  }
  return parts.join(' · ');
}

export function tooltip(c: RepoController): vscode.MarkdownString {
  const md = trustedMarkdown();
  const { icon, state } = look(c);
  const line = (codicon: string, text: string) => {
    md.appendMarkdown(`$(${codicon}) `);
    md.appendText(text);
    md.appendMarkdown('  \n');
  };
  const link = (codicon: string, label: string, command: string, arg: unknown = c.key) =>
    `[$(${codicon}) ${label}](command:${command}?${encodeURIComponent(JSON.stringify([arg]))})`;
  const links = (...items: string[]) => {
    md.appendMarkdown('\n---\n\n');
    md.appendMarkdown(items.join(' &nbsp;·&nbsp; '));
  };

  md.appendMarkdown('**apus · ');
  md.appendText(c.name);
  md.appendMarkdown('**');
  if (c.branch) {
    md.appendMarkdown(' — ');
    md.appendText(c.upstream ? `${c.branch} → ${c.upstream}` : c.branch);
  }
  md.appendMarkdown('\n\n');

  line(icon, state);
  if (c.missing) {
    line('folder', tildify(c.root.fsPath));
    links(link('search', vscode.l10n.t('Locate Folder…'), 'apus.relocate', c.asLost()));
    return md;
  }
  if (c.held) {
    line('file', heldSummary(c.held));
  }

  line('link', c.remote ? shortUrl(c.remote.url) : vscode.l10n.t('no URL to push to'));
  if (c.pending === 0) {
    line('check', vscode.l10n.t('no changes'));
  } else {
    const ignored = c.pending - c.relevant;
    line(
      'diff-modified',
      ignored > 0 ? vscode.l10n.t('{0} ({1} ignored by your rules)', uncommitted(c.pending), ignored) : uncommitted(c.pending),
    );
  }
  if (c.ahead > 0) {
    line('arrow-up', unpushed(c.ahead));
  }
  if (c.nextFlightAt !== undefined && !c.flying) {
    line('watch', vscode.l10n.t('next auto-commit: {0}', when(c.nextFlightAt)));
  }
  if (c.retryAt !== undefined && !c.flying) {
    line('sync', vscode.l10n.t('trying to push again: {0}', when(c.retryAt)));
  }
  line('cloud-upload', vscode.l10n.t('last push: {0}', c.lastPushAt === undefined ? vscode.l10n.t('unknown') : when(c.lastPushAt)));
  line('history', vscode.l10n.t('last auto-commit: {0}', c.lastAutoAt === undefined ? vscode.l10n.t('none yet') : when(c.lastAutoAt)));
  if (c.lastError) {
    const { flight } = c.lastError;
    line(c.offline ? 'cloud' : 'warning', flight.detail ? `${flightSummary(flight)} — ${flight.detail}` : flightSummary(flight));
  }

  links(
    c.watching ? link('eye-closed', vscode.l10n.t('Pause'), 'apus.toggleWatch') : link('eye', vscode.l10n.t('Watch'), 'apus.toggleWatch'),
    c.remote
      ? link('cloud-upload', vscode.l10n.t('Push Now'), 'apus.pushNow')
      : link('plug', vscode.l10n.t('Connect URL…'), 'apus.changeUrl'),
    c.held
      ? link('shield', vscode.l10n.t('Review…'), 'apus.reviewHeld')
      : c.lastError && !c.offline
        ? link('tools', vscode.l10n.t('Fix…'), 'apus.fixLast')
        : link('history', vscode.l10n.t('Auto-commits'), 'apus.showLog'),
  );
  return md;
}

/** Markdown con íconos y con links solo a los comandos de apus. */
export function trustedMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
  return md;
}
