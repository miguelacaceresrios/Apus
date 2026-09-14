import * as vscode from 'vscode';

export const SECTION = 'apus';

export interface RepoConfig {
  autoStart: boolean;
  quietMs: number;
  minGapMs: number;
  ignorePatterns: string[];
  messageTemplate: string;
  logSize: number;
}

export type NotifyLevel = 'all' | 'errors' | 'off';

// settings.json se edita a mano: cada valor se valida antes de usarlo.

export function readRepoConfig(scope: vscode.Uri): RepoConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope);
  return {
    autoStart: c.get('autoStart') === true,
    quietMs: seconds(c.get('watchInterval'), 120, 5),
    minGapMs: seconds(c.get('minInterval'), 300, 0),
    ignorePatterns: strings(c.get('ignorePatterns')),
    messageTemplate: nonEmpty(c.get('messageTemplate'), 'chore: auto-commit {date}'),
    logSize: Math.min(200, Math.max(1, Math.round(number(c.get('logSize'), 20)))),
  };
}

export function notifyLevel(): NotifyLevel {
  const v = vscode.workspace.getConfiguration(SECTION).get('notifications');
  return v === 'errors' || v === 'off' ? v : 'all';
}

export function configuredBinary(): string {
  return nonEmpty(vscode.workspace.getConfiguration(SECTION).get('path'), '');
}

function number(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function seconds(v: unknown, fallback: number, min: number): number {
  return Math.max(min, number(v, fallback)) * 1000;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function nonEmpty(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}
