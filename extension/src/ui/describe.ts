// Cómo se cuenta el estado de un repo. La barra, la vista y el menú usan lo mismo.

import * as vscode from 'vscode';
import { formatClock, formatRelative } from '../core/time';
import type { RepoController } from '../repos/repoController';

export interface Look {
  icon: string;
  color: string | undefined;
  state: string;
}

export function look(c: RepoController): Look {
  if (c.flying) {
    return { icon: 'sync~spin', color: undefined, state: 'subiendo…' };
  }
  if (c.lastError) {
    return { icon: 'warning', color: 'problemsWarningIcon.foreground', state: 'falló la última subida' };
  }
  if (!c.watching) {
    return { icon: 'eye-closed', color: undefined, state: 'en pausa' };
  }
  if (c.blocked) {
    return { icon: 'debug-pause', color: 'problemsWarningIcon.foreground', state: `detenido: ${c.blocked}` };
  }
  return { icon: 'eye', color: 'charts.orange', state: 'vigilando' };
}

/** Una línea: "vigilando · 3 cambios · push 10:48". */
export function summary(c: RepoController): string {
  const parts = [look(c).state];
  if (c.pending > 0) {
    parts.push(plural(c.pending, 'cambio', 'cambios'));
  }
  if (c.ahead > 0) {
    parts.push(`${c.ahead} sin subir`);
  }
  if (c.lastPushAt !== undefined) {
    parts.push(`push ${formatClock(c.lastPushAt)}`);
  }
  return parts.join(' · ');
}

export function tooltip(c: RepoController): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
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
    line('check', 'sin cambios');
  } else {
    const ignored = c.pending - c.relevant;
    line('diff-modified', plural(c.pending, 'cambio sin commitear', 'cambios sin commitear') +
      (ignored > 0 ? ` (${ignored} ignorados por las reglas)` : ''));
  }
  if (c.ahead > 0) {
    line('arrow-up', plural(c.ahead, 'commit sin subir', 'commits sin subir'));
  }
  if (c.nextFlightAt !== undefined) {
    line('clock', `próximo auto-commit: ${when(c.nextFlightAt)}`);
  }
  line('cloud-upload', `último push: ${c.lastPushAt === undefined ? 'sin datos' : when(c.lastPushAt)}`);
  line('history', `último auto-commit: ${c.lastAutoAt === undefined ? 'ninguno' : when(c.lastAutoAt)}`);
  if (c.lastError) {
    line('warning', c.lastError.detail ? `${c.lastError.summary} — ${c.lastError.detail}` : c.lastError.summary);
  }
  return md;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
}

function when(ms: number): string {
  return `${formatClock(ms)} (${formatRelative(ms)})`;
}
