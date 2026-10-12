// Las notas de una versión, sacadas de su sección del CHANGELOG:
//
//   node scripts/release-notes.mjs v0.4.0
//
// Falla si la versión no está en el CHANGELOG: no se publica una versión sin contar qué cambió.

import { readFileSync } from 'node:fs';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split(/\r?\n/);
// "## 0.5.0" o "## 0.5.0 - 2026-09-18".
const start = lines.findIndex((line) => line.trim() === `## ${version}` || line.startsWith(`## ${version} - `));
if (!version || start < 0) {
  console.error(`CHANGELOG.md no tiene la sección "## ${version}"`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
const notes = lines
  .slice(start + 1, end < 0 ? undefined : end)
  .join('\n')
  .trim();
console.log(notes);
