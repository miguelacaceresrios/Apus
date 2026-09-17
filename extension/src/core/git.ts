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

export interface Remote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface RemoteChange {
  name: string;
  url: string;
  /** Si el remoto ya existe. Si no, se agrega. */
  exists: boolean;
  /** Si el remoto tiene una URL de push aparte, que también hay que cambiar. */
  separatePushUrl: boolean;
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
  const r = await runProcess(git, ['reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/remotes/${upstream}`], { cwd: root });
  return r.code === 0 ? parseLastPush(r.stdout) : undefined;
}

export async function absoluteGitDir(git: string, root: string): Promise<string> {
  const r = await runProcess(git, ['rev-parse', '--absolute-git-dir'], { cwd: root });
  check(r, 'git rev-parse');
  return r.stdout.trim();
}

/** Raíz del repo que contiene a `dir`, o undefined si no está en ninguno. */
export async function toplevel(git: string, dir: string): Promise<string | undefined> {
  const r = await runProcess(git, ['rev-parse', '--show-toplevel'], { cwd: dir });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * Qué repo es este, sin importar la carpeta ni el remoto: sus commits raíz, de
 * todas las ramas (una rama huérfana tiene otro). Vacío si no tiene commits.
 */
export async function rootCommits(git: string, root: string): Promise<string[]> {
  const r = await runProcess(git, ['rev-list', '--max-parents=0', '--all'], { cwd: root });
  return r.code === 0 ? [...new Set(r.stdout.split(/\s+/).filter(Boolean))].sort() : [];
}

/** ¿`.gitignore` deja afuera a `relativePath`? */
export async function isIgnored(git: string, root: string, relativePath: string): Promise<boolean> {
  const r = await runProcess(git, ['check-ignore', '--quiet', '--', relativePath], { cwd: root });
  return r.code === 0;
}

/** `git init`, con la rama pedida si el git lo permite (desde 2.28). */
export async function initRepo(git: string, dir: string, branch: string): Promise<void> {
  let r = await runProcess(git, ['init', '-b', branch], { cwd: dir });
  if (r.code !== 0) {
    r = await runProcess(git, ['init'], { cwd: dir });
  }
  check(r, 'git init');
}

/** Los remotos, leídos de git y no de vscode.git: justo después de abrir un repo, su estado puede no estar listo. */
export async function readRemotes(git: string, root: string): Promise<Remote[]> {
  const r = await runProcess(git, ['remote', '-v'], { cwd: root });
  return r.code === 0 ? parseRemotes(r.stdout) : [];
}

export async function setRemoteUrl(git: string, root: string, change: RemoteChange): Promise<void> {
  const { name, url } = change;
  if (!change.exists) {
    check(await runProcess(git, ['remote', 'add', name, url], { cwd: root }), 'git remote add');
    return;
  }
  check(await runProcess(git, ['remote', 'set-url', name, url], { cwd: root }), 'git remote set-url');
  if (change.separatePushUrl) {
    check(await runProcess(git, ['remote', 'set-url', '--push', name, url], { cwd: root }), 'git remote set-url --push');
  }
}

function check(r: { code: number; stderr: string }, what: string): void {
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `${what} exited with code ${r.code}`);
  }
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

/** La salida de `git remote -v`: una línea de fetch y una de push por remoto. */
export function parseRemotes(stdout: string): Remote[] {
  const byName = new Map<string, Remote>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const remote = byName.get(m[1]!) ?? { name: m[1]! };
    if (m[3] === 'fetch') {
      remote.fetchUrl = m[2]!;
    } else {
      remote.pushUrl = m[2]!;
    }
    byName.set(remote.name, remote);
  }
  return [...byName.values()];
}

/**
 * Convierte la URL de un remoto en una navegable (https, sin .git ni
 * credenciales). Devuelve undefined para rutas locales u otros esquemas.
 */
export function browseUrl(remote: string): string | undefined {
  let u = remote.trim();
  if (u.startsWith('git@') && u.includes(':')) {
    const rest = u.slice('git@'.length);
    const colon = rest.indexOf(':');
    u = `https://${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  } else if (u.startsWith('ssh://git@')) {
    u = 'https://' + u.slice('ssh://git@'.length);
  } else if (u.startsWith('https://') || u.startsWith('http://')) {
    u = u.replace(/^(https?:\/\/)[^/@]*@/, '$1');
  } else {
    return undefined;
  }
  return u.replace(/\/$/, '').replace(/\.git$/, '');
}
