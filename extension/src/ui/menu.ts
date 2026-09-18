import * as vscode from 'vscode';
import { diagnose } from '../core/apus';
import { shortUrl } from '../core/remote';
import { formatRelative } from '../core/time';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import { summary } from './describe';
import { heldSummary } from './safety';
import { clock, duration, fixLabel, flightSummary, locale, tildify } from './text';

interface Action extends vscode.QuickPickItem {
  run?: () => unknown;
}

const separator = (label = ''): Action => ({ label, kind: vscode.QuickPickItemKind.Separator });
const run =
  (command: string, ...args: unknown[]) =>
  () =>
    vscode.commands.executeCommand(command, ...args);

/**
 * El menú del clic en la barra o en un repo de la vista. Primero lo que se hace
 * seguido, después la carpeta y la URL, al final lo de apus.
 */
export async function showMenu(registry: Registry, repo: RepoController): Promise<void> {
  const items: Action[] = [];

  if (repo.missing) {
    items.push(
      {
        label: `$(search) ${vscode.l10n.t('Locate Folder…')}`,
        description: tildify(repo.root.fsPath),
        run: run('apus.relocate', repo.asLost()),
      },
      {
        label: `$(close) ${vscode.l10n.t('Forget')}`,
        description: vscode.l10n.t('take it off the list'),
        run: run('apus.forget', repo.asLost()),
      },
    );
  } else {
    if (repo.held) {
      items.push({
        label: `$(shield) ${vscode.l10n.t('Review Held Files…')}`,
        description: heldSummary(repo.held),
        run: run('apus.reviewHeld', repo.key),
      });
    } else if (repo.lastError && !repo.offline) {
      const trouble = diagnose(repo.lastError.flight);
      items.push({
        label: `$(warning) ${fixLabel(trouble) ?? vscode.l10n.t('Last push failed')}`,
        description: flightSummary(repo.lastError.flight),
        run: run('apus.fixLast', repo.key),
      });
    } else if (!repo.remote) {
      items.push({
        label: `$(plug) ${vscode.l10n.t('Connect URL…')}`,
        description: vscode.l10n.t('needed to push'),
        run: run('apus.changeUrl', repo.key),
      });
    }
    items.push(
      { label: `$(cloud-upload) ${vscode.l10n.t('Push Now')}`, description: 'add + commit + push', run: run('apus.pushNow', repo.key) },
      repo.watching
        ? {
            label: `$(eye-closed) ${vscode.l10n.t('Pause')}`,
            description: vscode.l10n.t('stop pushing on its own'),
            run: () => repo.setWatching(false),
          }
        : {
            label: `$(eye) ${vscode.l10n.t('Watch')}`,
            description: vscode.l10n.t('push on its own after {0} without changes', duration(repo.config.quietMs)),
            run: () => repo.setWatching(true),
          },
      {
        label: `$(history) ${vscode.l10n.t('Auto-commits')}`,
        description:
          repo.lastAutoAt === undefined
            ? vscode.l10n.t('none yet')
            : vscode.l10n.t('last one {0}', formatRelative(repo.lastAutoAt, locale())),
        run: run('apus.showLog', repo.key),
      },
      separator(vscode.l10n.t('Repository')),
      {
        label: `$(folder) ${vscode.l10n.t('Change Folder…')}`,
        description: tildify(repo.root.fsPath),
        run: run('apus.changeFolder', repo.key),
      },
    );
    if (repo.remote) {
      items.push({
        label: `$(link) ${vscode.l10n.t('Change URL…')}`,
        description: shortUrl(repo.remote.url),
        run: run('apus.changeUrl', repo.key),
      });
    }
    if (repo.browseUrl()) {
      items.push({ label: `$(globe) ${vscode.l10n.t('Open in Browser')}`, run: run('apus.openRemote', repo.key) });
    }
    const allowed = repo.allowed().length;
    if (allowed > 0) {
      items.push({
        label: `$(pass) ${vscode.l10n.t('Files Let Through…')}`,
        description: vscode.l10n.t('{0} not checked before pushing', allowed),
        run: run('apus.reviewAllowed', repo.key),
      });
    }
    items.push({ label: `$(close) ${vscode.l10n.t('Remove from Apus')}`, run: run('apus.remove', repo.key) });
  }

  items.push(separator('apus'), { label: `$(add) ${vscode.l10n.t('Add Folder…')}`, run: run('apus.addFolder') });
  if (registry.all.length > 1) {
    items.push({
      label: `$(repo) ${vscode.l10n.t('Another Repository…')}`,
      run: async () => {
        const other = await registry.pick();
        if (other) {
          await showMenu(registry, other);
        }
      },
    });
  }
  items.push(
    {
      label: `$(settings-gear) ${vscode.l10n.t('Rules')}`,
      description: vscode.l10n.t('intervals, ignored files, message'),
      run: run('apus.openSettings'),
    },
    { label: `$(output) ${vscode.l10n.t('Show Log')}`, run: run('apus.showOutput') },
    { label: `$(book) ${vscode.l10n.t('Get Started')}`, run: run('apus.getStarted') },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: `apus · ${registry.label(repo)}`,
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
