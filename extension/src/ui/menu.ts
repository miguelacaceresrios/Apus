import * as vscode from 'vscode';
import { formatRelative } from '../core/time';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import { summary } from './describe';
import { clock, duration, locale } from './text';

interface Action extends vscode.QuickPickItem {
  run?: () => unknown;
}

/** El menú del clic en la barra o en un repo de la vista. */
export async function showMenu(registry: Registry, repo: RepoController): Promise<void> {
  const { quietMs, minGapMs, logSize } = repo.config;
  const items: Action[] = [
    repo.watching
      ? {
        label: `$(eye-closed) ${vscode.l10n.t('Pause watching')}`,
        detail: vscode.l10n.t('Stop auto-committing this repository.'),
        run: () => repo.setWatching(false),
      }
      : {
        label: `$(eye) ${vscode.l10n.t('Watch this repository')}`,
        detail: vscode.l10n.t('Auto-commit after {0} without changes, at most once every {1}.', duration(quietMs), duration(minGapMs)),
        run: () => repo.setWatching(true),
      },
    {
      label: `$(cloud-upload) ${vscode.l10n.t('Push now')}`,
      detail: vscode.l10n.t('add + commit + push with apus, without waiting.'),
      run: () => vscode.commands.executeCommand('apus.pushNow', repo),
    },
    {
      label: `$(history) ${vscode.l10n.t('Auto-commits')}`,
      detail: vscode.l10n.t('The last {0}.', logSize),
      run: () => showAutoCommits(repo),
    },
    {
      label: `$(settings-gear) ${vscode.l10n.t('Rules')}`,
      detail: vscode.l10n.t('Intervals, ignored patterns, message and notifications.'),
      run: () => vscode.commands.executeCommand('apus.openSettings'),
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(output) ${vscode.l10n.t('Log')}`, run: () => vscode.commands.executeCommand('apus.showOutput') },
    { label: `$(book) ${vscode.l10n.t('Get started')}`, run: () => vscode.commands.executeCommand('apus.getStarted') },
  ];
  if (registry.all.length > 1) {
    items.push({
      label: `$(repo) ${vscode.l10n.t('Another repository…')}`,
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
    void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: no auto-commits yet.', repo.name));
    return;
  }
  const web = repo.browseUrl();
  const picked = await vscode.window.showQuickPick(
    commits.map((commit) => ({
      label: `$(git-commit) ${commit.subject}`,
      description: commit.short,
      detail: `${clock(commit.at)} · ${formatRelative(commit.at, locale())}`,
      commit,
    })),
    {
      title: vscode.l10n.t('apus · {0} · auto-commits', repo.name),
      placeHolder: web ? vscode.l10n.t('Pick one to open it in the browser') : vscode.l10n.t('Pick one to copy its hash'),
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
    vscode.window.setStatusBarMessage(vscode.l10n.t('apus: copied {0}', picked.commit.short), 3000);
  }
}
