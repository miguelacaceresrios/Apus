import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

export interface ProcessResult {
  /** Código de salida; -1 si el proceso terminó por una señal o por el timeout. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Cuánto guardar de cada salida, en caracteres. Lo que sigue se descarta. */
  maxOutput?: number;
}

/**
 * La carpeta donde había que correr el proceso ya no existe. Sin esto, Node
 * avisa "spawn git ENOENT", que parece decir que falta git.
 */
export class MissingFolderError extends Error {
  constructor(readonly folder: string) {
    super(`folder not found: ${folder}`);
    this.name = 'MissingFolderError';
  }
}

const MAX_OUTPUT = 1024 * 1024;

/**
 * Ejecuta un binario con sus argumentos tal cual: sin shell, así nada de lo que
 * venga en un argumento (mensajes, rutas) se interpreta. La entrada estándar va
 * cerrada, para que ningún programa se quede esperando una respuesta.
 */
export function runProcess(file: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const limit = options.maxOutput ?? MAX_OUTPUT;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let failed = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < limit) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < limit) stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      // Después de 'error' igual llega 'close': que no resuelva por encima.
      failed = true;
      if (error.code !== 'ENOENT') {
        reject(error);
        return;
      }
      fs.stat(options.cwd).then(
        (st) => reject(st.isDirectory() ? error : new MissingFolderError(options.cwd)),
        () => reject(new MissingFolderError(options.cwd)),
      );
    });
    child.on('close', (code) => {
      if (!failed) {
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}
