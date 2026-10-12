// Carpetas temporales para las pruebas. Se borran cuando termina el archivo de
// pruebas que las creó, así no quedan cientos en el temporal.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after } from 'node:test';

const created: string[] = [];

after(async () => {
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

/** Una carpeta nueva, con su ruta real: en macOS el temporal es un symlink, y git devuelve la real. */
export async function tempDir(prefix = 'apus-affinis-'): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}
