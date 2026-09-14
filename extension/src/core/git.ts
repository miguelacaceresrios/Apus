// Lo que la extensión sabe de la historia sale de git, no de un archivo propio:
// así lo que muestra es verdad aunque los commits los haya hecho otra ventana,
// la terminal o el watcher de apus.

import { AUTO_TRAILER } from './apus';
import { runProcess } from './process';

export interface AutoCommit {
  hash: string;
  short: string;
  /** Milisegundos desde epoch. */
  at: number;
  subject: string;
}

const AUTO_GREP = `--grep=^${AUTO_TRAILER}$`;

export async function autoCommits(git: string, root: string, limit: number): Promise<AutoCommit[]> {
  const r = await runProcess(git, ['log', `-n${limit}`, AUTO_GREP, '--format=%H%x1f%h%x1f%ct%x1f%s%x1e'], { cwd: root });
  // Un repo sin commits hace fallar a git log: no hay nada que listar.
  return r.code === 0 ? parseAutoCommits(r.stdout) : [];
}

export async function lastAutoCommitAt(git: string, root: string): Promise<number | undefined> {
  return (await autoCommits(git, root, 1))[0]?.at;
}

/**
 * Último push de la rama, sacado del reflog de su rama remota: cada push deja
 * ahí una entrada "update by push" con la hora.
 */
export async function lastPushAt(git: string, root: string, upstream: string): Promise<number | undefined> {
  const r = await runProcess(
    git,
    ['reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/remotes/${upstream}`],
    { cwd: root },
  );
  return r.code === 0 ? parseLastPush(r.stdout) : undefined;
}

export async function absoluteGitDir(git: string, root: string): Promise<string> {
  const r = await runProcess(git, ['rev-parse', '--absolute-git-dir'], { cwd: root });
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `git rev-parse exited with code ${r.code}`);
  }
  return r.stdout.trim();
}

export function parseAutoCommits(stdout: string): AutoCommit[] {
  const out: AutoCommit[] = [];
  for (const record of stdout.split('\x1e')) {
    const [hash, short, ct, subject] = record.trim().split('\x1f');
    if (hash && short && ct && subject !== undefined) {
      out.push({ hash, short, at: Number(ct) * 1000, subject });
    }
  }
  return out;
}

export function parseLastPush(stdout: string): number | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /@\{(\d+)\}\t(.*)$/.exec(line);
    if (m && m[2] === 'update by push') {
      return Number(m[1]) * 1000;
    }
  }
  return undefined;
}

/**
 * Convierte la URL de un remoto en una navegable (https, sin .git). Devuelve
 * undefined para rutas locales u otros esquemas.
 */
export function browseUrl(remote: string): string | undefined {
  let u = remote.trim();
  if (u.startsWith('git@') && u.includes(':')) {
    const rest = u.slice('git@'.length);
    const colon = rest.indexOf(':');
    u = `https://${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  } else if (u.startsWith('ssh://git@')) {
    u = 'https://' + u.slice('ssh://git@'.length);
  } else if (!u.startsWith('https://') && !u.startsWith('http://')) {
    return undefined;
  }
  return u.replace(/\.git$/, '').replace(/\/$/, '');
}
