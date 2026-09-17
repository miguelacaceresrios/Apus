// Mirar una carpeta antes de sumarla, sin tocar nada. Lo que importa es no
// repetir lo de subir una carpeta que tiene un repo adentro: git guarda ese
// repo como un puntero, y en GitHub queda vacío.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isIgnored, toplevel } from './git';

export type Inspection =
  /** No existe, o no es una carpeta. */
  | { kind: 'missing' }
  /** Es la raíz de un repo. `nested`: repos que tiene adentro y que git subiría como punteros. */
  | { kind: 'repo'; nested: string[] }
  /** Está dentro del repo `root`, sin ser su raíz. */
  | { kind: 'inside'; root: string }
  /** Carpeta común. `nested`: repos que tiene adentro. */
  | { kind: 'plain'; nested: string[] };

/** Carpetas que no tiene sentido recorrer buscando repos (las mismas que saltea apus). */
const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__', 'venv', '.venv', 'Library', 'AppData']);

export async function inspectFolder(git: string, dir: string): Promise<Inspection> {
  if (!(await isDirectory(dir))) {
    return { kind: 'missing' };
  }
  if (await exists(path.join(dir, '.git'))) {
    return { kind: 'repo', nested: await embeddedRepos(git, dir) };
  }
  const root = await toplevel(git, dir);
  if (root !== undefined && !samePath(root, dir)) {
    return { kind: 'inside', root: path.resolve(root) };
  }
  if (root !== undefined) {
    return { kind: 'repo', nested: await embeddedRepos(git, dir) };
  }
  return { kind: 'plain', nested: await findRepos(dir) };
}

/**
 * Repos que `outer` tiene adentro y que git subiría como punteros: tienen su
 * propia carpeta .git (un submódulo tiene un archivo) y .gitignore no los deja
 * afuera.
 */
export async function embeddedRepos(git: string, outer: string, candidates?: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const inner of candidates ?? (await findRepos(outer))) {
    if (await isEmbeddedRepo(git, outer, inner)) {
      out.push(inner);
    }
  }
  return out;
}

export async function isEmbeddedRepo(git: string, outer: string, inner: string): Promise<boolean> {
  if (!(await isDirectory(path.join(inner, '.git')))) {
    return false;
  }
  const relative = path.relative(outer, inner).split(path.sep).join('/');
  return !(await isIgnored(git, outer, relative));
}

/**
 * Repos dentro de `dir`, sin contarlo a él. No entra dentro de un repo, y corta
 * a los `maxDepth` niveles o a las `maxDirs` carpetas: elegir C:\ no puede
 * colgar la ventana.
 */
export async function findRepos(dir: string, maxDepth = 3, maxDirs = 2000): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  let level = [dir];
  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const parent of level) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) {
          continue;
        }
        if (++visited > maxDirs) {
          return found.sort();
        }
        const child = path.join(parent, e.name);
        if (await exists(path.join(child, '.git'))) {
          found.push(child);
        } else {
          next.push(child);
        }
      }
    }
    level = next;
  }
  return found.sort();
}

/** Compara rutas como el sistema: git devuelve C:/x con barras normales, y Windows no distingue mayúsculas. */
export function samePath(a: string, b: string): boolean {
  const clean = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return clean(a) === clean(b);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isDirectory();
  } catch {
    return false;
  }
}
