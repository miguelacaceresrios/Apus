// Cómo se le habla a apus y cómo se lee lo que contesta. La extensión no
// reimplementa add + commit + push: se lo pide al binario, que es el que sabe.

import { runProcess } from './process';
import { redactCredentials } from './remote';
import { formatStamp } from './time';

/** Trailer que marca un commit como automático. Así se reconocen desde cualquier herramienta. */
export const AUTO_TRAILER = 'Apus-Auto: true';

/** Códigos de salida de apus. */
export const ExitCode = {
  ok: 0,
  repo: 1,
  usage: 2,
  push: 3,
} as const;

export interface Flight {
  code: number;
  ok: boolean;
  /**
   * Lo que apus resume al final: "main → origin/main", "nada que hacer…" o el
   * error, en el idioma de apus. Undefined si apus no dijo nada: la interfaz
   * explica el código.
   */
  summary: string | undefined;
  /** La línea que sigue al resumen: la URL si salió bien, la pista si falló. */
  detail: string | undefined;
  committed: boolean;
  pushed: boolean;
  /** Salida completa, para el registro. */
  output: string;
}

const FLIGHT_TIMEOUT_MS = 5 * 60_000;
const ANSI = /\x1b\[[0-9;]*m/g;

export function autoMessage(template: string, date: Date): string {
  const subject = (template.trim() || 'chore: auto-commit {date}').replaceAll('{date}', formatStamp(date));
  return `${subject}\n\n${AUTO_TRAILER}`;
}

export interface FlightOptions {
  /** Mensaje del commit; sin él, apus arma el suyo. */
  message?: string;
  /** Un vuelo automático: nadie lo pidió, así que no puede aparecer ninguna ventana pidiendo claves. */
  background: boolean;
}

/** Corre apus en `cwd`. */
export async function flyApus(binary: string, cwd: string, options: FlightOptions): Promise<Flight> {
  const args = options.message === undefined ? [] : ['--message', options.message];
  const result = await runProcess(binary, args, {
    cwd,
    timeoutMs: FLIGHT_TIMEOUT_MS,
    env: flightEnv(process.env, options.background),
  });
  return parseFlight(result.code, result.stderr, result.stdout);
}

/**
 * El entorno de apus y de los git que lance. Nunca pregunta por la terminal. En
 * segundo plano tampoco abre el inicio de sesión de Git Credential Manager ni el
 * de la clave SSH: si faltan credenciales, falla, y subir a mano lo resuelve.
 */
export function flightEnv(base: NodeJS.ProcessEnv, background: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  if (background) {
    env.GCM_INTERACTIVE = 'never';
    env.SSH_ASKPASS_REQUIRE = 'never';
  }
  return env;
}

export function parseFlight(code: number, stderr: string, stdout = ''): Flight {
  // apus imprime la URL del remoto tal cual: si trae un token, no llega ni al registro ni a los avisos.
  stdout = redactCredentials(stdout);
  const text = redactCredentials(stderr.replace(ANSI, ''));
  const lines = text.split(/\r?\n/);

  let summary: string | undefined;
  let detail: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith('✔ ') || line.startsWith('✖ ')) {
      summary = line.slice(2).trim();
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('  ') && next.trim()) {
        detail = next.trim();
      }
      break;
    }
  }
  if (!summary && code !== -1) {
    summary = lines.map((l) => l.trim()).find(Boolean);
  }

  const ran = (cmd: string) => lines.some((l) => l.startsWith(`» git ${cmd}`));
  return {
    code,
    ok: code === ExitCode.ok,
    summary,
    detail,
    // Con código 3 el commit ya quedó hecho y lo que falló fue el push.
    committed: ran('commit') && (code === ExitCode.ok || code === ExitCode.push),
    pushed: ran('push') && code === ExitCode.ok,
    output: [stdout, text].filter((s) => s.trim()).join('\n').trimEnd(),
  };
}

/** Qué salió mal, cuando se puede reconocer y hay algo concreto para arreglarlo. */
export type Trouble =
  /** El repo no tiene a dónde subir. */
  | 'noRemote'
  /** La URL apunta a un repo que no existe (borrado, renombrado o mal escrito). */
  | 'remoteNotFound'
  /** git no pudo iniciar sesión. */
  | 'auth'
  /** El remoto tiene commits que este repo no tiene. */
  | 'behind';

export function diagnose(flight: Flight): Trouble | undefined {
  if (flight.ok) {
    return undefined;
  }
  const text = [flight.summary, flight.detail, flight.output].join('\n');
  if (/no tiene remoto|git remote add origin|no configured push destination|No remote repository specified/i.test(text)) {
    return 'noRemote';
  }
  // Antes que "no encontrado": con SSH, un problema de clave también dice
  // "Could not read from remote repository".
  if (/Authentication failed|Permission denied|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)/i.test(text)) {
    return 'auth';
  }
  if (/Repository not found|repository '[^']*' not found|does not appear to be a git repository|remote: Not Found/i.test(text)) {
    return 'remoteNotFound';
  }
  if (/fetch first|non-fast-forward|\[rejected\]/.test(text)) {
    return 'behind';
  }
  return undefined;
}
