// Pruebas de integración dentro de un VS Code de verdad:
//
//   npm run test:integration
//
// Baja un VS Code estable aparte (queda en .vscode-test/) y lo abre con su
// propio perfil, sin tocar el tuyo. VSCODE_EXE usa otro VS Code en su lugar, y
// APUS_EXE elige el apus; sin APUS_EXE, la extensión lo busca en el PATH. En
// Linux sin pantalla, correrlo con xvfb-run.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const apus = process.env.APUS_EXE;

const fixture = mkdtempSync(join(tmpdir(), 'apus-affinis-it-'));
const ws = join(fixture, 'ws');
const remotes = join(fixture, 'remotes');
const env = { ...process.env, GIT_AUTHOR_NAME: 'apus', GIT_AUTHOR_EMAIL: 'apus@test', GIT_COMMITTER_NAME: 'apus', GIT_COMMITTER_EMAIL: 'apus@test' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });

function repo(dir, remote) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, 'config', 'user.name', 'apus');
  git(dir, 'config', 'user.email', 'apus@test');
  writeFileSync(join(dir, 'README.md'), `# ${dir}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'primero');
  if (remote) {
    git(fixture, 'init', '--bare', '--quiet', remote);
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  }
}

mkdirSync(remotes, { recursive: true });
repo(join(ws, 'ok'), join(remotes, 'ok.git'));
repo(join(ws, 'solo'));
repo(join(ws, 'secreto'), join(remotes, 'secreto.git'));
repo(join(ws, 'viper'), join(remotes, 'viper.git'));
repo(join(ws, 'viper', 'viper'));

const profile = join(fixture, 'profile');
mkdirSync(join(profile, 'User'), { recursive: true });
writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({
  ...(apus ? { 'apus.path': resolve(apus) } : {}),
  'apus.notifications': 'errors',
  // Auto-commits rápidos, para probarlos sin esperar minutos.
  'apus.watchInterval': 5,
  'apus.minInterval': 0,
  'git.openRepositoryInParentFolders': 'never',
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
}, null, 2));

execFileSync('npx', ['tsc', '-p', 'tsconfig.integration.json'], { cwd: root, stdio: 'inherit', shell: windows });

console.log(`repos de prueba en ${fixture}`);
// Corriendo desde una terminal de VS Code, esto viene puesto y haría que
// Code.exe arranque como Node en lugar de abrir una ventana.
delete process.env.ELECTRON_RUN_AS_NODE;
let status = 1;
try {
  status = await runTests({
    ...(process.env.VSCODE_EXE ? { vscodeExecutablePath: process.env.VSCODE_EXE } : { version: 'stable' }),
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test', 'integration', 'index.js'),
    launchArgs: [ws, `--user-data-dir=${profile}`, `--extensions-dir=${join(fixture, 'extensions')}`, '--new-window'],
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
}

const results = join(fixture, 'results.txt');
if (existsSync(results)) {
  console.log(readFileSync(results, 'utf8'));
}
// Si algo falló, los repos quedan para mirarlos.
if (status === 0) {
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(status);
