// Globs para apus.ignorePatterns, con la semántica que ya conocés de .gitignore:
// un patrón sin "/" vale a cualquier profundidad, y un patrón que nombra una
// carpeta cubre todo lo que tiene adentro.

/** Convierte un glob (`**`, `*`, `?`, `{a,b}`) en una expresión sobre rutas con "/". */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (g.startsWith('/')) {
    g = g.slice(1);
  } else if (!g.includes('/')) {
    g = '**/' + g;
  }
  if (g.endsWith('/')) {
    g = g.slice(0, -1);
  }

  let re = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?'; // "**/" también vale para ninguna carpeta
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
      braces++;
    } else if (c === '}' && braces > 0) {
      re += ')';
      braces--;
    } else if (c === ',' && braces > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
  }
  if (braces > 0) {
    throw new Error(`glob con llaves sin cerrar: ${glob}`);
  }
  return new RegExp('^' + re + '(?:/.*)?$');
}

/**
 * Compila una lista de globs en un predicado. Los patrones inválidos se
 * informan por `onInvalid` y se ignoran: uno mal escrito no apaga los demás.
 */
export function compileGlobs(
  patterns: readonly string[],
  onInvalid: (pattern: string, error: Error) => void = () => {},
): (relativePath: string) => boolean {
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    if (!p.trim()) {
      continue;
    }
    try {
      compiled.push(globToRegExp(p));
    } catch (e) {
      onInvalid(p, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return (relativePath) => {
    const path = relativePath.replace(/\\/g, '/');
    return compiled.some((re) => re.test(path));
  };
}
