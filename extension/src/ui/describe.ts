// Cómo se cuenta el estado de un repo. La barra, la vista y el menú usan lo mismo.

import * as vscode from 'vscode';
import { formatCountdown } from '../core/time';
import type { RepoController } from '../repos/repoController';
import { blockReason, changes, clock, flightSummary, uncommitted, unpushed, when } from './text';

/** Ícono propio, definido en package.json (contributes.icons) con images/apus-icons.woff. */
export const LOGO = 'apus-logo';

/** Comandos que se pueden disparar desde los links de un tooltip. */
const TOOLTIP_COMMANDS = ['apus.toggleWatch', 'apus.pushNow', 'apus.showLog', 'apus.fixBinary', 'apus.getStarted'];

export interface Look {
  icon: string;
  color: string | undefined;
  state: string;
}

export function look(c: RepoController): Look {
  if (c.flying) {
    return { icon: 'sync~spin', color: undefined, state: vscode.l10n.t('pushing…') };
  }
  if (c.lastError) {
    return { icon: 'warning', color: 'problemsWarningIcon.foreground', state: vscode.l10n.t('last push failed') };
  }
  if (!c.watching) {
    return { icon: 'eye-closed', color: undefined, state: vscode.l10n.t('paused') };
  }
  if (c.blocked) {
    return { icon: 'circle-slash', color: 'problemsWarningIcon.foreground', state: vscode.l10n.t('stopped: {0}', blockReason(c.blocked)) };
  }
  return { icon: LOGO, color: 'charts.orange', state: vscode.l10n.t('watching') };
}

/** "3 · en 1:40" o la hora del último push: lo que va al lado del ícono. */
export function countdown(c: RepoController, now = Date.now()): string | undefined {
  return c.nextFlightAt !== undefined && !c.flying ? vscode.l10n.t('in {0}', formatCountdown(c.nextFlightAt - now)) : undefined;
}

/** Una línea para la vista: "vigilando · 3 cambios · en 1:40". */
export function summary(c: RepoController): string {
  const parts = [look(c).state];
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

  md.appendMarkdown('**apus · ');
  md.appendText(c.name);
  md.appendMarkdown('**');
  if (c.branch) {
    md.appendMarkdown(' — ');
    md.appendText(c.upstream ? `${c.branch} → ${c.upstream}` : c.branch);
  }
  md.appendMarkdown('\n\n');

  line(icon, state);
  if (c.pending === 0) {
    line('check', vscode.l10n.t('no changes'));
  } else {
    const ignored = c.pending - c.relevant;
    line('diff-modified', ignored > 0 ? vscode.l10n.t('{0} ({1} ignored by your rules)', uncommitted(c.pending), ignored) : uncommitted(c.pending));
  }
  if (c.ahead > 0) {
    line('arrow-up', unpushed(c.ahead));
  }
  if (c.nextFlightAt !== undefined && !c.flying) {
    line('watch', vscode.l10n.t('next auto-commit: {0}', when(c.nextFlightAt)));
  }
  line('cloud-upload', vscode.l10n.t('last push: {0}', c.lastPushAt === undefined ? vscode.l10n.t('unknown') : when(c.lastPushAt)));
  line('history', vscode.l10n.t('last auto-commit: {0}', c.lastAutoAt === undefined ? vscode.l10n.t('none yet') : when(c.lastAutoAt)));
  if (c.lastError) {
    const { flight } = c.lastError;
    line('warning', flight.detail ? `${flightSummary(flight)} — ${flight.detail}` : flightSummary(flight));
  }

  const link = (codicon: string, label: string, command: string) =>
    `[$(${codicon}) ${label}](command:${command}?${encodeURIComponent(JSON.stringify([c.key]))})`;
  md.appendMarkdown('\n---\n\n');
  md.appendMarkdown([
    c.watching ? link('eye-closed', vscode.l10n.t('Pause'), 'apus.toggleWatch') : link('eye', vscode.l10n.t('Watch'), 'apus.toggleWatch'),
    link('cloud-upload', vscode.l10n.t('Push now'), 'apus.pushNow'),
    link('history', vscode.l10n.t('Auto-commits'), 'apus.showLog'),
  ].join(' &nbsp;·&nbsp; '));
  return md;
}

/** Markdown con íconos y con links solo a los comandos de apus. */
export function trustedMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
  return md;
}
