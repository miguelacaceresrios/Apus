// Cómo se le habla a apus y cómo se lee lo que contesta. La extensión no
// reimplementa add + commit + push: se lo pide al binario, que es el que sabe.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChangedFile } from './git';
import { runProcess } from './process';
import { redactCredentials } from './remote';
import { formatStamp } from './time';

/** Trailer que marca un commit como automático. Así se reconocen desde cualquier herramienta. */
export const AUTO_TRAILER = 'Apus-Auto: true';

/** Plantilla del mensaje de un auto-commit, si apus.messageTemplate no dice otra cosa. */
export const DEFAULT_TEMPLATE = 'chore: update {files}';

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
  /**
   * Por qué falló, en una palabra ("offline", "auth"…). Solo lo da apus 2.2.0
   * o posterior, con --json; con uno anterior se deduce del texto.
   */
  reason?: string;
  /** Salida completa, para el registro. */
  output: string;
}

const FLIGHT_TIMEOUT_MS = 5 * 60_000;
// eslint-disable-next-line no-control-regex -- los colores de la terminal empiezan con ESC, a propósito.
const ANSI = /\x1b\[[0-9;]*m/g;

/** Hasta cuántos archivos se listan en el cuerpo del mensaje. */
const FILES_IN_BODY = 20;
/** Hasta cuántos nombres entran en el asunto, con {files}. */
const FILES_IN_SUBJECT = 3;

/**
 * El mensaje de un auto-commit: el asunto de la plantilla ({date}, {files}), la
 * lista de archivos y el trailer, cada uno en su párrafo.
 */
export function autoMessage(template: string, date: Date, files: readonly ChangedFile[] = []): string {
  const stamp = formatStamp(date);
  const subject = (template.trim() || DEFAULT_TEMPLATE)
    .replaceAll('{date}', stamp)
    // Sin la lista (git no pudo darla), la fecha: el asunto nunca queda cortado.
    .replaceAll('{files}', files.length > 0 ? fileNames(files) : stamp);
  const body = files.slice(0, FILES_IN_BODY).map((f) => `${f.status} ${f.path}`);
  if (files.length > FILES_IN_BODY) {
    body.push(`… ${files.length - FILES_IN_BODY} more`);
  }
  return [subject, body.join('\n'), AUTO_TRAILER].filter(Boolean).join('\n\n');
}

/** "a.ts, b.ts, README.md +2": los nombres, sin carpetas, sin repetir. */
function fileNames(files: readonly ChangedFile[]): string {
  const names = [...new Set(files.map((f) => path.posix.basename(f.path.replace(/\/$/, ''))))];
  const shown = names.slice(0, FILES_IN_SUBJECT).join(', ');
  return names.length > FILES_IN_SUBJECT ? `${shown} +${names.length - FILES_IN_SUBJECT}` : shown;
}

export interface FlightOptions {
  /** Mensaje del commit; sin él, apus arma el suyo. */
  message?: string;
  /** Un vuelo automático: nadie lo pidió, así que no puede aparecer ninguna ventana pidiendo claves. */
  background: boolean;
}

/** Corre apus en `cwd`. */
export async function flyApus(binary: string, cwd: string, options: FlightOptions): Promise<Flight> {
  const json = await speaksJson(binary);
  const args = [...(json ? ['--json'] : []), ...(options.message === undefined ? [] : ['--message', options.message])];
  const result = await runProcess(binary, args, {
    cwd,
    timeoutMs: FLIGHT_TIMEOUT_MS,
    env: flightEnv(process.env, options.background),
  });
  return (json && parseJsonFlight(result.code, result.stdout, result.stderr)) || parseFlight(result.code, result.stderr, result.stdout);
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

/** Si el apus que dice `apus --version` entiende --json: desde la 2.2.0. */
export function versionSpeaksJson(versionOutput: string): boolean {
  const m = /\bapus (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) {
    return false;
  }
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 2);
}

/** Por binario y por versión del archivo: si lo actualizás en el mismo lugar, se vuelve a preguntar. */
const jsonSupport = new Map<string, Promise<boolean>>();

async function speaksJson(binary: string): Promise<boolean> {
  const stat = await fs.stat(binary).catch(() => undefined);
  const key = `${binary}\0${stat?.mtimeMs ?? 0}\0${stat?.size ?? 0}`;
  let known = jsonSupport.get(key);
  if (!known) {
    known = runProcess(binary, ['--version'], { cwd: path.dirname(binary), timeoutMs: 10_000 }).then(
      (r) => r.code === 0 && versionSpeaksJson(r.stdout),
      () => false,
    );
    jsonSupport.set(key, known);
  }
  return known;
}

/**
 * Lo que dice `apus --json`: una línea en stdout con el desenlace. Undefined si
 * no está o no se entiende: entonces se lee el texto, como con un apus viejo.
 */
export function parseJsonFlight(code: number, stdout: string, stderr: string): Flight | undefined {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (!line) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const d = data as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? redactCredentials(v.trim()) : undefined);
  if (typeof d.ok !== 'boolean') {
    return undefined;
  }
  // El código es el del proceso: si apus se pasó del tiempo, -1 aunque el JSON diga otra cosa.
  const ok = d.ok && code === ExitCode.ok;
  return {
    code,
    ok,
    summary: text(d.summary),
    detail: ok ? text(d.url) : text(d.hint),
    committed: d.committed === true,
    pushed: d.pushed === true,
    reason: ok ? undefined : text(d.reason),
    output: redactCredentials(stderr.replace(ANSI, '')).trimEnd(),
  };
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
    output: [stdout, text]
      .filter((s) => s.trim())
      .join('\n')
      .trimEnd(),
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
  | 'behind'
  /** No se pudo llegar al remoto: sin internet, o el servidor no contesta. Se reintenta solo. */
  | 'offline';

/** Los motivos de `apus --json` que tienen arreglo. */
const REASONS: Record<string, Trouble> = {
  noRemote: 'noRemote',
  notFound: 'remoteNotFound',
  auth: 'auth',
  behind: 'behind',
  offline: 'offline',
};

export function diagnose(flight: Flight): Trouble | undefined {
  if (flight.ok) {
    return undefined;
  }
  if (flight.reason !== undefined) {
    return REASONS[flight.reason];
  }
  const text = [flight.summary, flight.detail, flight.output].join('\n');
  if (/no tiene remoto|git remote add origin|no configured push destination|No remote repository specified/i.test(text)) {
    return 'noRemote';
  }
  // Primero la conexión: sin red, SSH también dice "Could not read from remote repository".
  if (
    /Could not resolve (host|hostname|proxy)|Temporary failure in name resolution|No such host is known|Name or service not known|Failed to connect to|Couldn't connect to server|Connection (timed out|refused|reset)|Operation timed out|Network is unreachable/i.test(
      text,
    )
  ) {
    return 'offline';
  }
  // Antes que "no encontrado": con SSH, un problema de clave también dice
  // "Could not read from remote repository".
  if (
    /Authentication failed|Permission denied|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)/i.test(
      text,
    )
  ) {
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
