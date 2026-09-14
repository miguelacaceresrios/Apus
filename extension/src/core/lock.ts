// Candado entre procesos. Dos ventanas de VS Code sobre el mismo repo son dos
// extension hosts: sin esto, las dos harían su auto-commit a la vez y chocarían
// en .git/index.lock.

import { promises as fs } from 'node:fs';

interface LockInfo {
  pid: number;
  at: number;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false; holder: LockInfo | undefined };

const STALE_MS = 10 * 60_000;

/**
 * Corre `fn` con el candado `file` tomado. Si lo tiene otro proceso vivo, no
 * espera: devuelve `acquired: false`. Un candado de un proceso muerto o de hace
 * más de `staleMs` se considera abandonado y se pisa.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, staleMs = STALE_MS): Promise<LockResult<T>> {
  const mine: LockInfo = { pid: process.pid, at: Date.now() };
  const body = JSON.stringify(mine);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, body, { flag: 'wx' });
    } catch (e) {
      if (!isCode(e, 'EEXIST')) {
        throw e;
      }
      const holder = await readLock(file);
      if (attempt === 0 && (!holder || isAbandoned(holder, staleMs))) {
        await fs.rm(file, { force: true });
        continue;
      }
      return { acquired: false, holder };
    }

    try {
      return { acquired: true, value: await fn() };
    } finally {
      // Solo lo borramos si sigue siendo nuestro.
      if ((await fs.readFile(file, 'utf8').catch(() => '')) === body) {
        await fs.rm(file, { force: true });
      }
    }
  }
  return { acquired: false, holder: await readLock(file) };
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      typeof data === 'object' && data !== null &&
      typeof (data as LockInfo).pid === 'number' && typeof (data as LockInfo).at === 'number'
    ) {
      return data as LockInfo;
    }
  } catch {
    // ilegible: se trata como abandonado
  }
  return undefined;
}

function isAbandoned(info: LockInfo, staleMs: number): boolean {
  return Date.now() - info.at > staleMs || !isAlive(info.pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: existe, pero es de otro usuario.
    return isCode(e, 'EPERM');
  }
}

function isCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;
}
