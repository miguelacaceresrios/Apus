import { spawn } from 'node:child_process';

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
}

const MAX_OUTPUT = 1024 * 1024;

/**
 * Ejecuta un binario con sus argumentos tal cual: sin shell, así nada de lo que
 * venga en un argumento (mensajes, rutas) se interpreta. La entrada estándar va
 * cerrada, para que ningún programa se quede esperando una respuesta.
 */
export function runProcess(file: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
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
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
