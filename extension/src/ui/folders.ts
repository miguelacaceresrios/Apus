// Elegir la carpeta de un repo. Antes de sumarla se mira qué es: un repo, una
// carpeta común (se ofrece inicializarla), la subcarpeta de un repo, o una
// carpeta con repos adentro, que es la forma de terminar con un repo vacío en
// GitHub.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { initRepo } from '../core/git';
import { exists, inspectFolder } from '../core/inspect';
import { shortUrl } from '../core/remote';
import type { Registry } from '../repos/registry';
import type { LostFolder, RepoController } from '../repos/repoController';
import { changeUrl } from './actions';
import { tildify } from './text';

/** Rama inicial al inicializar, la misma que usa apus. */
const DEFAULT_BRANCH = 'main';

/** Lo que reemplaza la carpeta elegida: un repo de la lista, o una carpeta que ya no está. */
export type Replaced = { repo: RepoController } | { lost: LostFolder };

interface FolderItem extends vscode.QuickPickItem {
  folder?: string;
}

/** Agregar una carpeta, o elegir la nueva carpeta de un repo. */
export async function addFolder(registry: Registry, replace?: Replaced, folder?: string): Promise<RepoController | undefined> {
  const chosen = folder ?? (await chooseFolder(registry, replace));
  if (!chosen) {
    return undefined;
  }
  const root = await resolveRoot(registry, chosen);
  if (!root) {
    return undefined;
  }

  const repo = await registry.addFolder(root);
  if (!repo) {
    void vscode.window.showErrorMessage(vscode.l10n.t('apus: VS Code could not open {0} as a git repository.', tildify(root)));
    return undefined;
  }

  const old = replace && ('repo' in replace ? replace.repo.asLost() : replace.lost);
  let message = vscode.l10n.t('apus: {0} is on the list.', repo.name);
  if (old && old.key !== repo.key) {
    const watched = registry.wasWatched(old.key);
    if (replace && 'repo' in replace) {
      await registry.remove(replace.repo);
    } else {
      await registry.forget(old);
    }
    if (watched) {
      await repo.setWatching(true);
    }
    message = watched
      ? vscode.l10n.t('apus: {0} now uses {1}, and it is still watched.', old.name, tildify(root))
      : vscode.l10n.t('apus: {0} now uses {1}.', old.name, tildify(root));
  }

  const remote = await repo.readRemote();
  if (!remote) {
    const connect = vscode.l10n.t('Connect URL…');
    const answer = await vscode.window.showInformationMessage(`${message} ${vscode.l10n.t('It has no URL to push to yet.')}`, connect);
    if (answer === connect) {
      await changeUrl(repo);
    }
    return repo;
  }
  const actions = repo.watching ? [] : [vscode.l10n.t('Watch')];
  void vscode.window
    .showInformationMessage(`${message} ${vscode.l10n.t('It pushes to {0}.', shortUrl(remote.url))}`, ...actions)
    .then((answer) => {
      if (answer) {
        void repo.setWatching(true);
      }
    });
  return repo;
}

async function chooseFolder(registry: Registry, replace: Replaced | undefined): Promise<string | undefined> {
  // Si sacaste repos de la lista, se pueden volver a traer sin buscarlos.
  const hidden = replace ? [] : registry.hidden;
  if (hidden.length > 0) {
    const items: FolderItem[] = [
      { label: `$(folder-opened) ${vscode.l10n.t('Choose a folder…')}` },
      { label: vscode.l10n.t('Removed from the list'), kind: vscode.QuickPickItemKind.Separator },
      ...hidden.map((r) => ({
        label: `$(repo) ${path.basename(r.rootUri.fsPath)}`,
        description: tildify(r.rootUri.fsPath),
        folder: r.rootUri.fsPath,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('apus · add a folder') });
    if (!picked) {
      return undefined;
    }
    if (picked.folder) {
      return picked.folder;
    }
  }

  const current = replace && ('repo' in replace ? replace.repo.root.fsPath : replace.lost.path);
  const start = await existingAncestor(
    current ? path.dirname(current) : registry.all[0] ? path.dirname(registry.all[0].root.fsPath) : undefined,
  );
  const picked = await vscode.window.showOpenDialog({
    title: current ? vscode.l10n.t('apus · new folder for {0}', path.basename(current)) : vscode.l10n.t('apus · add a folder'),
    openLabel: vscode.l10n.t('Use This Folder'),
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(start),
  });
  return picked?.[0]?.fsPath;
}

/** La carpeta que de verdad hay que sumar: la raíz del repo, sin repos adentro. Undefined si se cancela. */
async function resolveRoot(registry: Registry, dir: string): Promise<string | undefined> {
  const git = registry.gitPath;
  const look = (folder: string) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('apus: looking at {0}…', path.basename(folder)) },
      () => inspectFolder(git, folder),
    );

  let folder = dir;
  let inspection = await look(folder);
  if (inspection.kind === 'inside') {
    const root = inspection.root;
    const use = vscode.l10n.t('Use {0}', path.basename(root));
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('{0} is inside the repository {1}.', path.basename(folder), path.basename(root)),
      { modal: true, detail: vscode.l10n.t('apus pushes whole repositories, from their root folder: {0}', tildify(root)) },
      use,
    );
    if (answer !== use) {
      return undefined;
    }
    folder = root;
    inspection = await look(folder);
  }

  switch (inspection.kind) {
    case 'missing':
      void vscode.window.showErrorMessage(vscode.l10n.t('apus: {0} does not exist.', tildify(folder)));
      return undefined;
    case 'inside':
      return undefined;
    case 'repo':
      return inspection.nested.length === 0 ? folder : pickNested(folder, inspection.nested, true);
    case 'plain': {
      if (inspection.nested.length > 0) {
        return pickNested(folder, inspection.nested, false);
      }
      const init = vscode.l10n.t('Initialize');
      const answer = await vscode.window.showInformationMessage(
        vscode.l10n.t('{0} is not a git repository yet. Initialize it?', path.basename(folder)),
        {
          modal: true,
          detail: vscode.l10n.t(
            'apus runs git init in {0}, with the branch {1}. Then you paste the URL to push to.',
            tildify(folder),
            DEFAULT_BRANCH,
          ),
        },
        init,
      );
      if (answer !== init) {
        return undefined;
      }
      try {
        await initRepo(git, folder, DEFAULT_BRANCH);
      } catch (e) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t('apus: could not initialize {0}: {1}', path.basename(folder), e instanceof Error ? e.message : String(e)),
        );
        return undefined;
      }
      return folder;
    }
  }
}

/**
 * La carpeta tiene repos adentro. Si se sube la de afuera, git guarda cada repo
 * de adentro como un puntero y en GitHub quedan carpetas vacías: se ofrece
 * elegir uno de adentro.
 */
async function pickNested(folder: string, nested: readonly string[], isRepo: boolean): Promise<string | undefined> {
  const name = path.basename(folder);
  const items: FolderItem[] = nested.map((p) => ({
    label: `$(repo) ${path.basename(p)}`,
    description: path.relative(folder, p),
    folder: p,
  }));
  if (isRepo) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: `$(warning) ${vscode.l10n.t('Keep {0} anyway', name)}`,
        detail: vscode.l10n.t('The repositories inside are pushed as empty pointers, not their files.'),
        folder,
      },
    );
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: isRepo
      ? vscode.l10n.t('{0} has a repository inside', name)
      : vscode.l10n.t('{0} is not a repository, but it has repositories inside', name),
    placeHolder: vscode.l10n.t('Choose the one to add. Pushing the outer folder would leave empty folders on GitHub.'),
    ignoreFocusOut: true,
  });
  return picked?.folder;
}

async function existingAncestor(dir: string | undefined): Promise<string> {
  let current = dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      return os.homedir();
    }
    current = parent;
  }
  return current;
}
