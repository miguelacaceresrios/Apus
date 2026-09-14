// Cómo se le habla a apus y cómo se lee lo que contesta. La extensión no
// reimplementa add + commit + push: se lo pide al binario, que es el que sabe.

import { runProcess } from './process';
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
  /** Lo que apus resume al final: "main → origin/main", "nada que hacer…" o el error. */
  summary: string;
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

/** Corre apus en `cwd`. Con `message`, lo usa para el commit; sin él, apus arma el suyo. */
export async function flyApus(binary: string, cwd: string, message?: string): Promise<Flight> {
  const args = message === undefined ? [] : ['--message', message];
  const result = await runProcess(binary, args, {
    cwd,
    timeoutMs: FLIGHT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
  });
  return parseFlight(result.code, result.stderr, result.stdout);
}

export function parseFlight(code: number, stderr: string, stdout = ''): Flight {
  const text = stderr.replace(ANSI, '');
  const lines = text.split(/\r?\n/);

  let summary = '';
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
  if (!summary) {
    summary = code === -1
      ? 'apus no terminó a tiempo'
      : lines.map((l) => l.trim()).find(Boolean) ?? `apus terminó con código ${code}`;
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
