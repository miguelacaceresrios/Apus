import { constants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BinaryProblem =
  /** No hay apus en el PATH. */
  | 'notOnPath'
  /** apus.path no es una ruta absoluta. */
  | 'notAbsolute'
  /** apus.path apunta a apusw.exe, la versión de ventana, y no hay apus.exe al lado. */
  | 'windowBinary'
  /** En Windows, apus.path no es un .exe. */
  | 'notExe'
  /** apus.path apunta a algo que no existe o no se puede ejecutar. */
  | 'missing';

export type BinaryLookup = { ok: true; path: string } | { ok: false; problem: BinaryProblem; path?: string };

const isWindows = process.platform === 'win32';
export const APUS_EXE = isWindows ? 'apus.exe' : 'apus';

/**
 * Encuentra el binario de apus: la ruta configurada si hay una, si no el PATH.
 * En Windows solo acepta .exe: un .cmd, .bat o .sh necesita una shell, y eso es
 * justo lo que no queremos.
 */
export async function findApus(configured: string, env: NodeJS.ProcessEnv = process.env): Promise<BinaryLookup> {
  const wanted = configured.trim();
  if (wanted) {
    return checkConfigured(wanted);
  }

  for (const dir of pathEntries(env)) {
    const candidate = path.join(dir, APUS_EXE);
    if (await isExecutable(candidate)) {
      return { ok: true, path: candidate };
    }
  }
  return { ok: false, problem: 'notOnPath' };
}

async function checkConfigured(wanted: string): Promise<BinaryLookup> {
  const file = wanted.startsWith('~') ? path.join(os.homedir(), wanted.slice(1)) : wanted;
  if (!path.isAbsolute(file)) {
    return { ok: false, problem: 'notAbsolute', path: wanted };
  }
  if (isWindows) {
    // apusw.exe es la versión de ventana: ante un error abre un diálogo en vez de
    // escribirlo. Si al lado está apus.exe, usamos ese.
    if (path.basename(file).toLowerCase() === 'apusw.exe') {
      const sibling = path.join(path.dirname(file), 'apus.exe');
      return (await isExecutable(sibling)) ? { ok: true, path: sibling } : { ok: false, problem: 'windowBinary', path: file };
    }
    if (path.extname(file).toLowerCase() !== '.exe') {
      return { ok: false, problem: 'notExe', path: file };
    }
  }
  return (await isExecutable(file)) ? { ok: true, path: file } : { ok: false, problem: 'missing', path: file };
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  // En Windows la variable puede llamarse Path, y un proceso lanzado con un
  // entorno armado a mano puede traer Path y PATH a la vez: se miran todas.
  return Object.keys(env)
    .filter((k) => k.toUpperCase() === 'PATH')
    .flatMap((k) => (env[k] ?? '').split(path.delimiter))
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && path.isAbsolute(d));
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) {
      return false;
    }
    if (!isWindows) {
      await fs.access(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
