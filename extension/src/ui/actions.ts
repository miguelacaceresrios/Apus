// Lo que se hace sobre un repo desde la vista, el menú o un aviso.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { diagnose } from '../core/apus';
import { checkRemoteUrl, shortUrl } from '../core/remote';
import type { Registry } from '../repos/registry';
import type { RepoController } from '../repos/repoController';
import { urlMessage } from './text';

/** Conectar la URL a la que sube el repo, o cambiarla. Devuelve si quedó conectado. */
export async function changeUrl(repo: RepoController): Promise<boolean> {
  const current = await repo.readRemote();
  // Si la URL guardada trae usuario o token, no se muestra: se pega una nueva.
  const withCredentials = current !== undefined && /^[a-z+]+:\/\/[^/@]+@/i.test(current.url);
  const input = await vscode.window.showInputBox({
    title: current ? vscode.l10n.t('apus · {0} · change URL', repo.name) : vscode.l10n.t('apus · {0} · connect URL', repo.name),
    prompt: current
      ? vscode.l10n.t('It pushes to {0} now. Paste the new URL.', shortUrl(current.url))
      : vscode.l10n.t('Paste the URL of the repository to push to. If you create it on GitHub, create it empty, without a README.'),
    value: withCredentials ? undefined : current?.url,
    placeHolder: 'https://github.com/user/repo.git',
    ignoreFocusOut: true,
    validateInput: (value) => urlMessage(checkRemoteUrl(value)),
  });
  const check = input === undefined ? undefined : checkRemoteUrl(input);
  if (!check?.ok) {
    return false;
  }
  if (current?.url === check.url) {
    return true;
  }
  if (current) {
    const change = vscode.l10n.t('Change URL');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('Change where {0} pushes?', repo.name),
      { modal: true, detail: `${shortUrl(current.url)}\n→ ${shortUrl(check.url)}` },
      change,
    );
    if (answer !== change) {
      return false;
    }
  }

  try {
    await repo.setRemoteUrl(check.url);
  } catch (e) {
    void vscode.window.showErrorMessage(vscode.l10n.t('apus · {0}: could not save the URL: {1}', repo.name, message(e)));
    return false;
  }
  const push = vscode.l10n.t('Push Now');
  void vscode.window
    .showInformationMessage(vscode.l10n.t('apus · {0} pushes to {1}.', repo.name, shortUrl(check.url)), push)
    .then((answer) => {
      if (answer === push) {
        void pushNow(repo);
      }
    });
  return true;
}

export async function pushNow(repo: RepoController): Promise<void> {
  if (repo.missing) {
    await vscode.commands.executeCommand('apus.relocate', repo.asLost());
    return;
  }
  // Sin URL, apus solo puede decir que falta: mejor pedirla directamente.
  if (!(await repo.readRemote()) && !(await changeUrl(repo))) {
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('apus: pushing {0}', repo.name) }, () =>
    repo.pushNow(),
  );
}

/** Lo que conviene hacer después del último error. */
export async function fixLast(repo: RepoController, log: vscode.LogOutputChannel): Promise<void> {
  const trouble = repo.lastError ? diagnose(repo.lastError.flight) : undefined;
  switch (trouble) {
    case 'noRemote':
    case 'remoteNotFound':
      await changeUrl(repo);
      return;
    case 'behind':
      openTerminal(repo, 'git pull --rebase');
      return;
    case 'offline':
    case 'signing':
      await pushNow(repo);
      return;
    default:
      log.show(true);
  }
}

/** Una terminal en el repo con el comando escrito, sin ejecutarlo: lo decidís vos. */
export function openTerminal(repo: RepoController, command: string): void {
  const terminal = vscode.window.createTerminal({ name: `apus · ${repo.name}`, cwd: repo.root });
  terminal.show();
  terminal.sendText(command, false);
}

export async function openRemote(repo: RepoController): Promise<void> {
  const web = repo.browseUrl();
  if (web) {
    await vscode.env.openExternal(vscode.Uri.parse(web));
  } else if (repo.remote) {
    await vscode.env.clipboard.writeText(repo.remote.url);
    vscode.window.setStatusBarMessage(vscode.l10n.t('apus: URL copied'), 3000);
  }
}

export async function removeRepo(registry: Registry, repo: RepoController): Promise<void> {
  const watched = repo.watching;
  const folder = repo.root.fsPath;
  await registry.remove(repo);
  const undo = vscode.l10n.t('Undo');
  const text = watched
    ? vscode.l10n.t('apus: {0} is off the list and no longer watched.', repo.name)
    : vscode.l10n.t('apus: {0} is off the list.', repo.name);
  const answer = await vscode.window.showInformationMessage(text, undo);
  if (answer === undo) {
    const back = await registry.addFolder(folder);
    if (back && watched) {
      await back.setWatching(true);
    }
  }
}

/** Explica qué pasa con un repo dentro de otro, y ofrece sumar el de adentro. */
export async function explainNested(registry: Registry, repo: RepoController): Promise<void> {
  if (repo.nested.length === 0) {
    return;
  }
  const names = repo.nested.map((p) => path.basename(p)).join(', ');
  const addable = repo.nested.filter((p) => !registry.has(p)).slice(0, 2);
  const buttons = addable.map((p) => vscode.l10n.t('Add {0}', path.basename(p)));
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('{0} has another repository inside: {1}', repo.name, names),
    {
      modal: true,
      detail: vscode.l10n.t(
        'git does not push the files of a repository that lives inside another one: it pushes a pointer, and on GitHub that folder looks empty. Push the inner repository on its own, and add its folder to the .gitignore of {0}.',
        repo.name,
      ),
    },
    ...buttons,
  );
  const index = answer === undefined ? -1 : buttons.indexOf(answer);
  if (index >= 0) {
    await vscode.commands.executeCommand('apus.addFolder', addable[index]);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
