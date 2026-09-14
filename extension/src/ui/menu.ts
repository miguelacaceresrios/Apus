import * as vscode from 'vscode';
import { formatClock, formatRelative } from '../core/time';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import { duration, summary } from './describe';

interface Action extends vscode.QuickPickItem {
  run?: () => unknown;
}

/** El menú del clic en la barra o en un repo de la vista. */
export async function showMenu(registry: Registry, repo: RepoController): Promise<void> {
  const { quietMs, minGapMs, logSize } = repo.config;
  const items: Action[] = [
    repo.watching
      ? {
        label: '$(eye-closed) Pausar la vigilancia',
        detail: 'Deja de hacer auto-commits en este repo.',
        run: () => repo.setWatching(false),
      }
      : {
        label: '$(eye) Vigilar este repo',
        detail: `Auto-commit tras ${duration(quietMs)} sin cambios, como mucho uno cada ${duration(minGapMs)}.`,
        run: () => repo.setWatching(true),
      },
    {
      label: '$(cloud-upload) Subir ahora',
      detail: 'add + commit + push con apus, sin esperar.',
      run: () => vscode.commands.executeCommand('apus.pushNow', repo),
    },
    {
      label: '$(history) Commits automáticos',
      detail: `Los últimos ${logSize}.`,
      run: () => showAutoCommits(repo),
    },
    {
      label: '$(settings-gear) Reglas',
      detail: 'Intervalos, patrones ignorados, mensaje y notificaciones.',
      run: () => vscode.commands.executeCommand('apus.openSettings'),
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(output) Registro', run: () => vscode.commands.executeCommand('apus.showOutput') },
  ];
  if (registry.all.length > 1) {
    items.push({
      label: '$(repo) Otro repo…',
      run: async () => {
        const other = await registry.pick();
        if (other) {
          await showMenu(registry, other);
        }
      },
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `apus · ${repo.name}`,
    placeHolder: summary(repo),
  });
  await picked?.run?.();
}

export async function showAutoCommits(repo: RepoController): Promise<void> {
  const commits = await repo.autoCommits();
  if (commits.length === 0) {
    void vscode.window.showInformationMessage(`apus · ${repo.name}: todavía no hay commits automáticos.`);
    return;
  }
  const web = repo.browseUrl();
  const picked = await vscode.window.showQuickPick(
    commits.map((commit) => ({
      label: `$(git-commit) ${commit.subject}`,
      description: commit.short,
      detail: `${formatClock(commit.at)} · ${formatRelative(commit.at)}`,
      commit,
    })),
    {
      title: `apus · ${repo.name} · commits automáticos`,
      placeHolder: web ? 'Elegí uno para verlo en el navegador' : 'Elegí uno para copiar su hash',
      matchOnDescription: true,
    },
  );
  if (!picked) {
    return;
  }
  if (web) {
    await vscode.env.openExternal(vscode.Uri.parse(`${web}/commit/${picked.commit.hash}`));
  } else {
    await vscode.env.clipboard.writeText(picked.commit.hash);
    vscode.window.setStatusBarMessage(`apus: hash ${picked.commit.short} copiado`, 3000);
  }
}
