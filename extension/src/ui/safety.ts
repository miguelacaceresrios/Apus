// Lo que frenó una subida, explicado para una persona, y cómo arreglarlo sin
// salir de VS Code.

import * as vscode from 'vscode';
import { GITHUB_FILE_LIMIT, type Finding, type RuleId } from '../core/safety';
import type { RepoController } from '../repos/repoController';

interface FindingItem extends vscode.QuickPickItem {
  finding: Finding;
}

export function isSecret(f: Finding): boolean {
  return f.rule !== 'largeFile';
}

/** "src/config.ts:12", "src/config.ts (commit abc1234)", o solo la ruta. */
export function location(f: Finding): string {
  if (f.commit) {
    return `${f.path} (${vscode.l10n.t('commit {0}', f.commit)})`;
  }
  return f.line ? `${f.path}:${f.line}` : f.path;
}

export function ruleText(f: Pick<Finding, 'rule' | 'size'>): string {
  const rule: RuleId = f.rule;
  switch (rule) {
    case 'envFile':
      return vscode.l10n.t('environment file, usually with passwords and keys');
    case 'sshKey':
      return vscode.l10n.t('SSH private key');
    case 'keyStore':
      return vscode.l10n.t('key or certificate store');
    case 'credentials':
      return vscode.l10n.t('credentials file');
    case 'terraformState':
      return vscode.l10n.t('Terraform state, which can hold secrets');
    case 'passwordDb':
      return vscode.l10n.t('password database');
    case 'privateKey':
      return vscode.l10n.t('private key');
    case 'githubToken':
      return vscode.l10n.t('GitHub token');
    case 'gitlabToken':
      return vscode.l10n.t('GitLab token');
    case 'awsKey':
      return vscode.l10n.t('AWS access key');
    case 'slackToken':
      return vscode.l10n.t('Slack token');
    case 'stripeKey':
      return vscode.l10n.t('Stripe live key');
    case 'googleKey':
      return vscode.l10n.t('Google API key');
    case 'anthropicKey':
      return vscode.l10n.t('Anthropic API key');
    case 'openaiKey':
      return vscode.l10n.t('OpenAI API key');
    case 'npmToken':
      return vscode.l10n.t('npm token');
    case 'urlPassword':
      return vscode.l10n.t('URL with a password');
    case 'largeFile': {
      const size = megabytes(f.size ?? 0);
      return (f.size ?? 0) > GITHUB_FILE_LIMIT
        ? vscode.l10n.t('{0} MB: GitHub rejects files over 100 MB', size)
        : vscode.l10n.t('{0} MB: over your apus.maxFileSize', size);
    }
  }
}

/** ".env, src/config.ts:12 (+2)": lo que va al lado del estado. */
export function heldSummary(findings: readonly Finding[]): string {
  const names = [...new Set(findings.map(location))];
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} (+${names.length - 2})` : shown;
}

export function heldState(findings: readonly Finding[]): string {
  return findings.some(isSecret)
    ? vscode.l10n.t('held back: possible secret')
    : vscode.l10n.t('held back: file too big');
}

/** Qué conviene hacer con cada aviso. */
function advice(f: Finding): string {
  if (f.commit) {
    return vscode.l10n.t('It is in commit {0}, which is not pushed yet: .gitignore does not take it out. Undo that commit (git reset --soft) and commit again without it.', f.commit);
  }
  if (!isSecret(f)) {
    return f.tracked
      ? vscode.l10n.t('Stop tracking it, or use Git LFS for big files.')
      : vscode.l10n.t('Add it to .gitignore, or use Git LFS for big files.');
  }
  if (f.line) {
    return vscode.l10n.t('Move the secret out of line {0} (to an environment variable, for example) and save.', f.line);
  }
  return f.tracked
    ? vscode.l10n.t('Git already tracks it: stop tracking it to keep it only on your machine.')
    : vscode.l10n.t('Add it to .gitignore to keep it only on your machine.');
}

/** Subir a mano con algo encontrado. True si se decide subir igual. */
export async function confirmHeld(repo: RepoController, findings: readonly Finding[]): Promise<boolean> {
  const review = vscode.l10n.t('Review…');
  const push = vscode.l10n.t('Push Anyway');
  const secret = findings.some(isSecret);
  const lines = findings.slice(0, 8).map((f) => `• ${location(f)} — ${ruleText(f)}`);
  if (findings.length > 8) {
    lines.push(vscode.l10n.t('…and {0} more', findings.length - 8));
  }
  const why = secret
    ? vscode.l10n.t('A secret that reaches GitHub has to be treated as leaked, even if you delete it afterwards.')
    : vscode.l10n.t('GitHub rejects files over 100 MB, and the push fails.');
  const answer = await vscode.window.showWarningMessage(
    secret
      ? vscode.l10n.t('{0} has files that look like secrets. Push anyway?', repo.name)
      : vscode.l10n.t('{0} has files too big to push. Push anyway?', repo.name),
    { modal: true, detail: `${lines.join('\n')}\n\n${why}` },
    review,
    push,
  );
  if (answer === review) {
    void vscode.commands.executeCommand('apus.reviewHeld', repo.key);
  }
  return answer === push;
}

/** La lista de lo frenado, con un botón por arreglo. Se actualiza sola al arreglar. */
export async function reviewHeld(repo: RepoController): Promise<void> {
  const findings = await repo.recheck();
  if (findings.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: nothing is held back. The next push goes through.', repo.name));
    return;
  }

  const ignore: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('exclude'), tooltip: vscode.l10n.t('Add to .gitignore') };
  const untrack: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('debug-disconnect'),
    tooltip: vscode.l10n.t('Stop tracking it and add it to .gitignore (the file stays on your disk)'),
  };
  const allow: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('pass'), tooltip: vscode.l10n.t('Not a secret: let it through') };

  const picker = vscode.window.createQuickPick<FindingItem>();
  picker.title = vscode.l10n.t('apus · {0} · held back', repo.name);
  picker.placeholder = vscode.l10n.t('Nothing is pushed while these are here. Pick one to open it, or use its buttons.');
  picker.matchOnDescription = true;
  picker.ignoreFocusOut = true;
  const render = (list: readonly Finding[]) => {
    picker.items = list.map((finding) => ({
      label: `$(${isSecret(finding) ? 'key' : 'file-binary'}) ${location(finding)}`,
      description: ruleText(finding),
      detail: advice(finding),
      finding,
      buttons: [
        // Lo que ya está en un commit no se arregla con .gitignore: queda el consejo.
        ...(finding.commit ? [] : [finding.tracked ? untrack : ignore]),
        // Dejar pasar un archivo que GitHub rechaza no sirve de nada.
        ...((finding.size ?? 0) > GITHUB_FILE_LIMIT ? [] : [allow]),
      ],
    }));
  };
  render(findings);

  picker.onDidTriggerItemButton(async ({ item, button }) => {
    const f = item.finding;
    picker.busy = true;
    try {
      if (button === ignore) {
        await repo.ignoreFile(f);
      } else if (button === untrack) {
        const stop = vscode.l10n.t('Stop Tracking');
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t('Stop tracking {0}?', f.path),
          { modal: true, detail: vscode.l10n.t('The file stays on your disk. The next commit removes it from the repository, and it goes into .gitignore. If it was already pushed, it is still in the history: change that secret.') },
          stop,
        );
        if (answer === stop) {
          await repo.stopTracking(f);
        }
      } else if (button === allow) {
        await repo.allow(f);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(vscode.l10n.t('apus · {0}: {1}', repo.name, e instanceof Error ? e.message : String(e)));
    } finally {
      picker.busy = false;
    }
    const left = repo.held ?? [];
    if (left.length === 0) {
      picker.hide();
      void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: all clear. The next push goes through.', repo.name));
    } else {
      render(left);
    }
  });
  picker.onDidAccept(() => {
    const f = picker.selectedItems[0]?.finding;
    if (f) {
      picker.hide();
      void openFinding(repo, f);
    }
  });
  picker.onDidHide(() => picker.dispose());
  picker.show();
}

/** Lo que se marcó como falso aviso, para volver a revisarlo. */
export async function reviewAllowed(repo: RepoController): Promise<void> {
  const keys = repo.allowed();
  if (keys.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: you have not let anything through.', repo.name));
    return;
  }
  const picked = await vscode.window.showQuickPick(
    keys.map((key) => {
      const space = key.indexOf(' ');
      const rule = key.slice(0, space) as RuleId;
      return { label: `$(pass) ${key.slice(space + 1)}`, description: ruleText({ rule }), key };
    }),
    {
      title: vscode.l10n.t('apus · {0} · let through', repo.name),
      placeHolder: vscode.l10n.t('Pick the ones to check again before pushing'),
      canPickMany: true,
    },
  );
  if (picked && picked.length > 0) {
    await repo.forgetAllowed(picked.map((p) => p.key));
    void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: they are checked again before pushing.', repo.name));
  }
}

async function openFinding(repo: RepoController, f: Finding): Promise<void> {
  const uri = vscode.Uri.joinPath(repo.root, ...f.path.split('/'));
  if (f.commit) {
    // Un número de línea de un commit viejo no sirve para el archivo de hoy: se muestra el commit.
    const terminal = vscode.window.createTerminal({ name: `apus · ${repo.name}`, cwd: repo.root });
    terminal.show();
    terminal.sendText(`git show --stat ${f.commit}`, true);
    return;
  }
  if (f.line === undefined && (f.rule === 'largeFile' || f.rule === 'keyStore' || f.rule === 'passwordDb')) {
    await vscode.commands.executeCommand('revealFileInOS', uri);
    return;
  }
  const line = Math.max(0, (f.line ?? 1) - 1);
  await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true });
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}
