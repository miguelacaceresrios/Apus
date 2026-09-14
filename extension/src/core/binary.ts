import { constants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BinaryLookup = { ok: true; path: string } | { ok: false; reason: string };

const isWindows = process.platform === 'win32';
const EXE = isWindows ? 'apus.exe' : 'apus';

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
    const candidate = path.join(dir, EXE);
    if (await isExecutable(candidate)) {
      return { ok: true, path: candidate };
    }
  }
  return { ok: false, reason: `no encontré ${EXE} en el PATH` };
}

async function checkConfigured(wanted: string): Promise<BinaryLookup> {
  const file = wanted.startsWith('~') ? path.join(os.homedir(), wanted.slice(1)) : wanted;
  if (!path.isAbsolute(file)) {
    return { ok: false, reason: `apus.path tiene que ser una ruta absoluta (hoy es "${wanted}")` };
  }
  if (isWindows) {
    // apusw.exe es la versión de ventana: ante un error abre un diálogo en vez de
    // escribirlo. Si al lado está apus.exe, usamos ese.
    if (path.basename(file).toLowerCase() === 'apusw.exe') {
      const sibling = path.join(path.dirname(file), 'apus.exe');
      return (await isExecutable(sibling))
        ? { ok: true, path: sibling }
        : { ok: false, reason: 'apusw.exe es la versión de ventana: apuntá apus.path a apus.exe' };
    }
    if (path.extname(file).toLowerCase() !== '.exe') {
      return { ok: false, reason: 'apus.path tiene que apuntar a un .exe' };
    }
  }
  return (await isExecutable(file))
    ? { ok: true, path: file }
    : { ok: false, reason: `apus.path apunta a ${file}, que no existe o no es ejecutable` };
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  // En Windows la variable puede llamarse Path.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const value = key ? env[key] ?? '' : '';
  return value
    .split(path.delimiter)
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
