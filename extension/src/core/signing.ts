// Commits firmados. Si git firma cada commit con GPG y la clave no está en la
// caché del agente, un auto-commit abriría la ventana de la contraseña de GPG
// (pinentry) cada vez, o se quedaría esperando. Antes de un auto-commit se
// prueba firmar sin preguntar: si no se puede, no se intenta.

import { runProcess } from './process';

export interface Signing {
  format: 'openpgp' | 'x509' | 'ssh';
  /** El programa que usa git para firmar. */
  program: string;
  key: string | undefined;
}

const TRUE = new Set(['true', 'yes', 'on', '1']);

/** Cómo firma git los commits de este repo; undefined si no los firma. */
export async function commitSigning(git: string, root: string): Promise<Signing | undefined> {
  const r = await runProcess(
    git,
    [
      'config',
      '-z',
      '--get-regexp',
      '^(commit\\.gpgsign|gpg\\.format|gpg\\.program|gpg\\.(openpgp|x509|ssh)\\.program|user\\.signingkey)$',
    ],
    { cwd: root },
  );
  return r.code === 0 ? parseSigning(r.stdout) : undefined;
}

/** La salida de `git config -z --get-regexp`: "clave\nvalor\0" por entrada; gana la última. */
export function parseSigning(stdout: string): Signing | undefined {
  const config = new Map<string, string>();
  for (const entry of stdout.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline > 0) {
      config.set(entry.slice(0, newline).toLowerCase(), entry.slice(newline + 1));
    }
  }
  if (!TRUE.has((config.get('commit.gpgsign') ?? '').toLowerCase())) {
    return undefined;
  }
  const raw = (config.get('gpg.format') ?? 'openpgp').toLowerCase();
  const format = raw === 'x509' || raw === 'ssh' ? raw : 'openpgp';
  const fallback = format === 'x509' ? 'gpgsm' : format === 'ssh' ? 'ssh-keygen' : 'gpg';
  const program = config.get(`gpg.${format}.program`) ?? (format === 'openpgp' ? config.get('gpg.program') : undefined) ?? fallback;
  return { format, program, key: config.get('user.signingkey') || undefined };
}

/**
 * ¿Puede firmar sin preguntarle nada a nadie? Con SSH sí: sin terminal y con
 * SSH_ASKPASS_REQUIRE=never, si falta la clave falla en lugar de preguntar. Con
 * GPG se firma algo vacío con --pinentry-mode error: si la contraseña no está en
 * la caché del agente, falla al instante, sin abrir ninguna ventana.
 */
export async function signsQuietly(signing: Signing, cwd: string): Promise<boolean> {
  if (signing.format === 'ssh') {
    return true;
  }
  const args = ['--batch', '--no-tty', '--pinentry-mode', 'error', ...(signing.key ? ['--local-user', signing.key] : []), '--sign'];
  try {
    const r = await runProcess(signing.program, args, { cwd, timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    // Sin el programa, el commit va a fallar igual, y apus dice por qué.
    return true;
  }
}
