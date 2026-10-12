// Antes de subir, mirar qué se va a subir. Un auto-commit hace `git add -A` sin
// que nadie mire: si en la carpeta quedó un .env, una clave privada o un token
// pegado en un archivo, se iría a GitHub, y un secreto publicado hay que darlo
// por perdido aunque después se borre. También frena los archivos que GitHub
// rechaza por grandes, que dejan el repo trabado con un push que nunca sale.
//
// Se revisa exactamente lo que subiría apus:
//   - lo que cambió respecto del último commit (solo las líneas nuevas) y los
//     archivos que git todavía no sigue, sin lo que deja afuera .gitignore;
//   - los commits que todavía no están en ningún remoto, que el push sube
//     aunque se hayan hecho desde la terminal o desde Source Control.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runProcess } from './process';

export type RuleId =
  // Por el nombre del archivo.
  | 'envFile'
  | 'sshKey'
  | 'keyStore'
  | 'credentials'
  | 'terraformState'
  | 'passwordDb'
  // Por lo que tiene adentro.
  | 'privateKey'
  | 'githubToken'
  | 'gitlabToken'
  | 'awsKey'
  | 'slackToken'
  | 'stripeKey'
  | 'googleKey'
  | 'anthropicKey'
  | 'openaiKey'
  | 'npmToken'
  | 'urlPassword'
  // Por el tamaño.
  | 'largeFile';

export interface Finding {
  /** Relativa a la raíz del repo, con "/". */
  path: string;
  rule: RuleId;
  /** Dónde aparece, en las reglas de contenido. */
  line?: number;
  /** Tamaño en bytes, en largeFile. */
  size?: number;
  /** Si git ya sigue el archivo: en ese caso .gitignore no alcanza para dejarlo afuera. */
  tracked: boolean;
  /**
   * El commit sin subir donde aparece. Ya es historia: .gitignore no lo saca,
   * hay que rehacer ese commit.
   */
  commit?: string;
}

export interface CheckOptions {
  /** Los archivos más grandes que esto se frenan. */
  maxFileBytes: number;
  /** Lo que el usuario ya revisó y dejó pasar. */
  isAllowed?: (finding: Finding) => boolean;
}

export interface CheckResult {
  findings: Finding[];
  /** Había tanto para leer que parte del contenido quedó sin revisar. */
  partial: boolean;
}

/** Una línea agregada: su número en el archivo nuevo y su texto. */
export interface AddedLine {
  line: number;
  text: string;
}

export interface PatchFile {
  /** El commit, si el parche sale de `git log -p`. */
  commit?: string;
  path: string;
  added: AddedLine[];
}

/** GitHub rechaza un push con un archivo de más de esto. */
export const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_FILE_TO_READ = 2 * 1024 * 1024;
const MAX_FILES_TO_READ = 5000;
const MAX_BYTES_TO_READ = 64 * 1024 * 1024;
/** Más commits sin subir que esto se revisan en parte. */
const MAX_UNPUSHED_COMMITS = 500;
/** Una línea minificada puede medir megas: se revisa el principio. */
const MAX_LINE = 20_000;

/** Nombres de ejemplo que se suben a propósito: .env.example, secrets.sample.json. */
const EXAMPLE_NAME = /example|sample|template|\.dist$|defaults?$/i;

const NAME_RULES: { rule: RuleId; test: (name: string, relative: string) => boolean }[] = [
  { rule: 'envFile', test: (n) => (/^\.env(\.|$)/i.test(n) || /.\.env$/i.test(n)) && !EXAMPLE_NAME.test(n) },
  { rule: 'sshKey', test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(n) },
  { rule: 'keyStore', test: (n) => /\.(p12|pfx|jks|keystore|ppk)$/i.test(n) },
  {
    rule: 'credentials',
    test: (n, rel) =>
      !EXAMPLE_NAME.test(n) &&
      (/^(\.netrc|_netrc|\.git-credentials|\.pgpass|\.pypirc|\.htpasswd|\.dockercfg|credentials\.json)$/i.test(n) ||
        /^client_secret.*\.json$/i.test(n) ||
        /service.?account.*\.json$/i.test(n) ||
        /^secrets?\.(json|ya?ml|toml|ini|txt)$/i.test(n) ||
        /(^|\/)\.aws\/credentials$/.test(rel)),
  },
  { rule: 'terraformState', test: (n) => /\.tfstate(\.backup)?$/i.test(n) },
  { rule: 'passwordDb', test: (n) => /\.(kdbx|kdb|agilekeychain|1pif)$/i.test(n) },
];

// Solo formatos que se reconocen sin dudas: un aviso falso cada tanto hace que
// se ignoren todos. Los cuantificadores tienen tope, así una línea larga no
// dispara un recorrido cuadrático.
const CONTENT_RULES: { rule: RuleId; re: RegExp }[] = [
  { rule: 'privateKey', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { rule: 'githubToken', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g },
  { rule: 'gitlabToken', re: /\bglpat-[A-Za-z0-9_-]{20}\b/g },
  { rule: 'awsKey', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: 'slackToken', re: /\bxox[abposr]-[A-Za-z0-9-]{10,72}\b/g },
  { rule: 'stripeKey', re: /\b[rs]k_live_[A-Za-z0-9]{20,99}\b/g },
  { rule: 'googleKey', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { rule: 'anthropicKey', re: /\bsk-ant-[a-z]{3,9}\d{2}-[A-Za-z0-9_-]{80,120}/g },
  { rule: 'openaiKey', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,200}T3BlbkFJ[A-Za-z0-9_-]{16,200}/g },
  { rule: 'npmToken', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: 'urlPassword', re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]{1,64}:([^\s/@'"`]{3,128})@[\w-]+(?:\.[\w-]+)+/gi },
];

/** Lo que se escribe en la documentación en lugar de un secreto de verdad. */
const PLACEHOLDER = /example|x{6,}|0{8,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|your|dummy|fake|placeholder|redacted|changeme/i;
const PLACEHOLDER_PASSWORD = /^(\$\w+|password|passw(or)?d|pass|pwd|pw|secret|token|clave|contrase(ñ|n)a)$/i;

/** Revisa lo que subiría apus en `root`: los cambios, y los commits que no están en ningún remoto. */
export async function checkPending(git: string, root: string, options: CheckOptions): Promise<CheckResult> {
  const [changes, history] = await Promise.all([checkChanges(git, root, options), checkUnpushed(git, root)]);
  const seen = new Set<string>();
  const findings: Finding[] = [];
  // Si algo está en los cambios y en un commit sin subir, se muestra primero lo que se puede arreglar sin rehacer commits.
  for (const f of [...changes.findings, ...history.findings]) {
    const key = `${f.rule} ${f.path} ${f.commit ?? ''}`;
    if (!seen.has(key) && !options.isAllowed?.(f)) {
      seen.add(key);
      findings.push(f);
    }
  }
  return { findings, partial: changes.partial || history.partial };
}

/** Los cambios sin commitear: lo que agregaría el próximo commit. */
async function checkChanges(git: string, root: string, options: CheckOptions): Promise<CheckResult> {
  const status = await runProcess(
    git,
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: root, maxOutput: OUTPUT_LIMIT },
  );
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || `git status exited with code ${status.code}`);
  }
  const entries = parseStatus(status.stdout);
  let partial = status.stdout.length >= OUTPUT_LIMIT;

  // Las líneas nuevas de lo que git ya sigue. Sin commits todavía, no hay con qué comparar: se lee todo.
  let patch: Map<string, AddedLine[]> | undefined;
  if (entries.some((e) => e.tracked)) {
    const diff = await runProcess(git, ['-c', 'core.quotepath=false', 'diff', 'HEAD', ...PATCH_FLAGS], {
      cwd: root,
      maxOutput: OUTPUT_LIMIT,
    });
    if (diff.code === 0) {
      patch = new Map(parsePatch(diff.stdout).map((f) => [f.path, f.added]));
      partial ||= diff.stdout.length >= OUTPUT_LIMIT;
    }
  }

  const findings: Finding[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  for (const { path: relative, tracked } of entries) {
    findings.push(...nameFindings(relative, { tracked }));

    const file = path.join(root, relative);
    let size: number;
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) {
        continue;
      }
      size = st.size;
    } catch {
      continue;
    }
    if (size > options.maxFileBytes) {
      findings.push({ path: relative, rule: 'largeFile', size, tracked });
      continue;
    }

    // De un archivo que git ya sigue solo cuentan las líneas nuevas: un secreto
    // que ya estaba en el último commit no se avisa de nuevo en cada cambio.
    const added = tracked ? patch?.get(relative) : undefined;
    if (added) {
      findings.push(...scanLines(added).map((hit) => ({ path: relative, rule: hit.rule, line: hit.line, tracked })));
      continue;
    }
    if (tracked && patch && !partial) {
      continue; // sin líneas nuevas: solo borró, o es binario
    }
    if (size > MAX_FILE_TO_READ || filesRead >= MAX_FILES_TO_READ || bytesRead >= MAX_BYTES_TO_READ) {
      partial = true;
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch {
      continue;
    }
    filesRead++;
    bytesRead += buffer.length;
    if (!isBinary(buffer)) {
      findings.push(...scanText(buffer.toString('utf8')).map((hit) => ({ path: relative, rule: hit.rule, line: hit.line, tracked })));
    }
  }

  // Con Git LFS se commitea un puntero chico, no el archivo: su tamaño en disco no cuenta.
  const large = findings.filter((f) => f.rule === 'largeFile').map((f) => f.path);
  if (large.length > 0) {
    const lfs = await lfsTracked(git, root, large);
    return { findings: findings.filter((f) => f.rule !== 'largeFile' || !lfs.has(f.path)), partial };
  }
  return { findings, partial };
}

/** De estos archivos, los que `.gitattributes` manda a Git LFS. */
async function lfsTracked(git: string, root: string, paths: readonly string[]): Promise<Set<string>> {
  const r = await runProcess(git, ['-c', 'core.quotepath=false', 'check-attr', '-z', 'filter', '--', ...paths], { cwd: root });
  const lfs = new Set<string>();
  if (r.code === 0) {
    // -z: ruta, atributo y valor, cada uno terminado en NUL.
    const parts = r.stdout.split('\0');
    for (let i = 0; i + 2 < parts.length; i += 3) {
      if (parts[i + 2] === 'lfs') {
        lfs.add(parts[i]!);
      }
    }
  }
  return lfs;
}

/** Los commits que no están en ningún remoto: el push los sube aunque no los haya hecho apus. */
async function checkUnpushed(git: string, root: string): Promise<CheckResult> {
  const range = ['HEAD', '--not', '--remotes', `--max-count=${MAX_UNPUSHED_COMMITS + 1}`];
  const [names, patches] = await Promise.all([
    runProcess(
      git,
      ['-c', 'core.quotepath=false', 'log', '--format=commit %h', '--name-only', '--diff-filter=AM', '--no-renames', ...range],
      { cwd: root, maxOutput: OUTPUT_LIMIT },
    ),
    runProcess(git, ['-c', 'core.quotepath=false', 'log', '--format=commit %h', '-p', ...PATCH_FLAGS, ...range], {
      cwd: root,
      maxOutput: OUTPUT_LIMIT,
    }),
  ]);
  // Sin commits todavía, git log falla: no hay historia que revisar.
  if (names.code !== 0 || patches.code !== 0) {
    return { findings: [], partial: false };
  }

  const findings: Finding[] = [];
  let commit: string | undefined;
  let commits = 0;
  for (const line of names.stdout.split(/\r?\n/)) {
    const header = /^commit ([0-9a-f]{4,40})$/.exec(line);
    if (header) {
      commit = header[1];
      commits++;
    } else if (line && commit) {
      findings.push(...nameFindings(line, { tracked: true, commit }));
    }
  }
  for (const file of parsePatch(patches.stdout)) {
    findings.push(
      ...scanLines(file.added).map((hit) => ({ path: file.path, rule: hit.rule, line: hit.line, tracked: true, commit: file.commit })),
    );
  }
  return {
    findings,
    partial: commits > MAX_UNPUSHED_COMMITS || names.stdout.length >= OUTPUT_LIMIT || patches.stdout.length >= OUTPUT_LIMIT,
  };
}

const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0'];

function nameFindings(relative: string, where: { tracked: boolean; commit?: string }): Finding[] {
  const name = path.posix.basename(relative);
  return NAME_RULES.filter(({ test }) => test(name, relative)).map(({ rule }) => ({ path: relative, rule, ...where }));
}

/** Los secretos en un texto, con el número de línea (empieza en 1). */
export function scanText(text: string): { rule: RuleId; line: number }[] {
  return scanLines(text.split('\n').map((t, i) => ({ line: i + 1, text: t })));
}

/** Los secretos en esas líneas. Un aviso por regla alcanza. */
export function scanLines(lines: readonly AddedLine[]): { rule: RuleId; line: number }[] {
  const hits: { rule: RuleId; line: number }[] = [];
  const seen = new Set<RuleId>();
  for (const { line, text } of lines) {
    const t = text.slice(0, MAX_LINE);
    for (const { rule, re } of CONTENT_RULES) {
      if (seen.has(rule)) {
        continue;
      }
      for (const match of t.matchAll(re)) {
        const secret = rule === 'urlPassword' ? match[1]! : match[0];
        if (!PLACEHOLDER.test(secret) && !(rule === 'urlPassword' && PLACEHOLDER_PASSWORD.test(secret))) {
          hits.push({ rule, line });
          seen.add(rule);
          break;
        }
      }
    }
  }
  return hits;
}

/** `git status --porcelain=v1 -z --no-renames`: lo que subiría, sin lo borrado. */
export function parseStatus(stdout: string): { path: string; tracked: boolean }[] {
  const out: { path: string; tracked: boolean }[] = [];
  for (const entry of stdout.split('\0')) {
    if (entry.length < 4) {
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    // Una carpeta con "/" al final es un repo adentro de este: no tiene contenido propio que revisar.
    if (file.endsWith('/') || y === 'D' || (x === 'D' && y === ' ')) {
      continue;
    }
    out.push({ path: file, tracked: !(x === '?' && y === '?') });
  }
  return out;
}

/**
 * Las líneas agregadas de un `git diff --unified=0`, o de un `git log -p` con
 * `--format=commit %h`. Un archivo borrado no aparece; uno binario, tampoco.
 */
export function parsePatch(text: string): PatchFile[] {
  const out: PatchFile[] = [];
  let commit: string | undefined;
  let current: PatchFile | undefined;
  let line = 0;
  let newLeft = 0;
  let oldLeft = 0;
  for (const raw of text.split('\n')) {
    if (newLeft > 0 || oldLeft > 0) {
      // Dentro de un bloque: el primer carácter dice de qué lado es la línea.
      if (raw.startsWith('+')) {
        current?.added.push({ line: line++, text: raw.slice(1).replace(/\r$/, '') });
        newLeft--;
      } else if (raw.startsWith('-')) {
        oldLeft--;
      } else if (raw.startsWith(' ')) {
        line++;
        newLeft--;
        oldLeft--;
      }
      continue;
    }
    const header = raw.replace(/\r$/, '');
    const commitHeader = /^commit ([0-9a-f]{4,40})$/.exec(header);
    if (commitHeader) {
      commit = commitHeader[1];
      current = undefined;
      continue;
    }
    if (header.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (header.startsWith('+++ ')) {
      const target = diffPath(header.slice(4));
      current = target === undefined ? undefined : { ...(commit ? { commit } : {}), path: target, added: [] };
      if (current) {
        out.push(current);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      line = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return out;
}

/** "b/src/a.ts", con comillas si git las puso. Undefined para /dev/null. */
function diffPath(raw: string): string | undefined {
  let p = raw.replace(/\t$/, '');
  if (p === '/dev/null') {
    return undefined;
  }
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
  }
  return p.startsWith('b/') ? p.slice(2) : p;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Agrega el archivo a .gitignore, anclado a la raíz ("/config/.env"), con lo
 * especial de .gitignore escapado. No lo repite si ya está.
 */
export async function addToGitignore(root: string, relative: string): Promise<void> {
  const file = path.join(root, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
  const entry = gitignoreEntry(relative);
  if (current.split(/\r?\n/).includes(entry)) {
    return;
  }
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current === '' || current.endsWith('\n') ? '' : eol;
  await fs.writeFile(file, `${current}${separator}${entry}${eol}`);
}

export function gitignoreEntry(relative: string): string {
  const escaped = relative.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
  return `/${escaped}`;
}

/** Deja de seguir el archivo en git, sin borrarlo del disco, y lo agrega a .gitignore. */
export async function stopTracking(git: string, root: string, relative: string): Promise<void> {
  // --literal-pathspecs: un nombre como ":(glob)*" es un nombre, no un patrón.
  const r = await runProcess(git, ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--', relative], { cwd: root });
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `git rm exited with code ${r.code}`);
  }
  await addToGitignore(root, relative);
}
