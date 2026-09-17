// Pruebas de integración con el VS Code y el apus que tengas instalados:
//
//   npm run test:integration
//
// VSCODE_EXE y APUS_EXE cambian dónde buscarlos. Arma repos de prueba en una
// carpeta temporal, abre una ventana aparte (con su propio perfil, sin tocar
// el tuyo) y corre test/integration.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';

const code = process.env.VSCODE_EXE ?? (windows
  ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')
  : 'code');
const apus = process.env.APUS_EXE;
if (windows && !existsSync(code)) {
  console.error(`no encontré VS Code en ${code}: definí VSCODE_EXE`);
  process.exit(2);
}

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

const user = join(fixture, 'profile', 'User');
mkdirSync(user, { recursive: true });
writeFileSync(join(user, 'settings.json'), JSON.stringify({
  ...(apus ? { 'apus.path': apus } : {}),
  'apus.notifications': 'errors',
  // Auto-commits rápidos, para probarlos sin esperar minutos.
  'apus.watchInterval': 5,
  'apus.minInterval': 0,
  'security.workspace.trust.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'workbench.startupEditor': 'none',
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
}, null, 2));

execFileSync('npx', ['tsc', '-p', 'tsconfig.integration.json'], { cwd: root, stdio: 'inherit', shell: windows });

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const args = [
  ws,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${join(root, 'out', 'test', 'integration', 'index.js')}`,
  `--user-data-dir=${join(fixture, 'profile')}`,
  `--extensions-dir=${join(fixture, 'extensions')}`,
  '--new-window',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-workspace-trust',
];
console.log(`repos de prueba en ${fixture}`);
const child = spawn(code, args, { env: childEnv, stdio: 'inherit' });
child.on('exit', (status) => {
  const results = join(fixture, 'results.txt');
  if (existsSync(results)) {
    console.log(readFileSync(results, 'utf8'));
  }
  // Si algo falló, los repos quedan para mirarlos.
  if (status === 0) {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exit(status ?? 1);
});
