// Globs para apus.ignorePatterns, con la semántica que ya conocés de .gitignore:
// un patrón sin "/" vale a cualquier profundidad, y un patrón que nombra una
// carpeta cubre todo lo que tiene adentro.
//
// No se traducen a expresiones regulares. Un patrón como "**/**/**/x" genera una
// regex que tarda minutos en una ruta larga, y los patrones pueden venir del
// settings.json de un repo: bastaría uno para colgar VS Code. Se comparan por
// partes, recordando lo ya probado, en un tiempo proporcional a patrón × ruta.

export type GlobMatcher = (relativePath: string) => boolean;

/** Un patrón más largo que esto no tiene sentido en un settings.json. */
const MAX_LENGTH = 1000;
/** Cuántas variantes puede generar un patrón con llaves: "{a,b}{c,d}" son 4. */
const MAX_ALTERNATIVES = 64;

/** Compila un glob (`**`, `*`, `?`, `{a,b}`) en un predicado sobre rutas relativas. */
export function compileGlob(glob: string): GlobMatcher {
  let g = glob.trim().replace(/\\/g, '/');
  if (g.length > MAX_LENGTH) {
    throw new Error(`glob too long (${g.length} characters)`);
  }
  if (g.startsWith('/')) {
    g = g.slice(1);
  } else if (!g.includes('/')) {
    g = '**/' + g;
  }
  if (g.endsWith('/')) {
    g = g.slice(0, -1);
  }

  const alternatives = expandBraces(g, glob).map(segments);
  return (relativePath) => {
    const path = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    return alternatives.some((pattern) => matchSegments(pattern, path));
  };
}

/**
 * Compila una lista de globs en un predicado. Los patrones inválidos se
 * informan por `onInvalid` y se ignoran: uno mal escrito no apaga los demás.
 */
export function compileGlobs(patterns: readonly string[], onInvalid: (pattern: string, error: Error) => void = () => {}): GlobMatcher {
  const compiled: GlobMatcher[] = [];
  for (const p of patterns) {
    if (!p.trim()) {
      continue;
    }
    try {
      compiled.push(compileGlob(p));
    } catch (e) {
      onInvalid(p, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return (relativePath) => compiled.some((matches) => matches(relativePath));
}

/** "a/**\/**\/b" → ["a", "**", "b"]: dos "**" seguidos valen lo mismo que uno. */
function segments(pattern: string): string[] {
  const out: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment && !(segment === '**' && out[out.length - 1] === '**')) {
      out.push(segment);
    }
  }
  return out;
}

/** "*.{png,jpg}" → ["*.png", "*.jpg"]. Las llaves pueden anidarse. */
function expandBraces(glob: string, original: string): string[] {
  const open = glob.indexOf('{');
  if (open < 0) {
    return [glob];
  }
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) {
      commas.push(i);
    }
  }
  if (close < 0) {
    throw new Error(`unclosed brace in glob: ${original}`);
  }

  const parts: string[] = [];
  let start = open + 1;
  for (const comma of commas) {
    parts.push(glob.slice(start, comma));
    start = comma + 1;
  }
  parts.push(glob.slice(start, close));

  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const out: string[] = [];
  for (const part of parts) {
    for (const expanded of expandBraces(head + part + tail, original)) {
      out.push(expanded);
      if (out.length > MAX_ALTERNATIVES) {
        throw new Error(`too many alternatives in glob: ${original}`);
      }
    }
  }
  return out;
}

/**
 * ¿La ruta coincide con el patrón, o está adentro de lo que nombra? `**` vale
 * por cero o más carpetas. Cada par (parte del patrón, parte de la ruta) se
 * prueba una sola vez.
 */
function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (p: number, s: number): boolean => {
    if (p === pattern.length) {
      return true;
    }
    const key = p * (path.length + 1) + s;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result =
      pattern[p] === '**'
        ? go(p + 1, s) || (s < path.length && go(p, s + 1))
        : s < path.length && matchSegment(pattern[p]!, path[s]!) && go(p + 1, s + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** `*` y `?` dentro de una parte de la ruta, sin backtracking exponencial. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') {
    p++;
  }
  return p === pattern.length;
}
