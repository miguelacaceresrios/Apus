import * as vscode from 'vscode';
import { notifyLevel, SECTION } from '../config';
import { diagnose } from '../core/apus';
import type { Finding } from '../core/safety';
import type { RepoController } from '../repos/repoController';
import type { FlightReport } from '../repos/types';
import { isSecret, location, ruleText } from './safety';
import { changes, fixLabel, flightSummary, tildify, troubleText } from './text';

/** Avisos de VS Code en lugar de notify-send, según apus.notifications. */
export class Notifier {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  /**
   * Muestra el desenlace de un vuelo. Lo manual siempre se informa; lo
   * automático, según el ajuste, y un error repetido no se vuelve a avisar.
   * Si el error se reconoce, el aviso trae el botón que lo arregla.
   */
  report({ repo, kind, flight, changes: count }: FlightReport, repeatedError: boolean): void {
    const level = notifyLevel();
    const auto = kind === 'auto';
    const summary = flightSummary(flight);

    if (!flight.ok) {
      const trouble = diagnose(flight);
      // Sin conexión no hay nada que arreglar: lo automático se reintenta en
      // silencio, y la vista lo muestra. Solo se avisa si lo pidió el usuario.
      if (trouble === 'offline') {
        if (!auto) {
          this.offline(repo, flight.committed);
        }
        return;
      }
      if (auto && (level === 'off' || repeatedError)) {
        return;
      }
      const fix = fixLabel(trouble);
      const showLog = vscode.l10n.t('Show Log');
      const actions = fix ? [fix, showLog] : [showLog];
      void vscode.window
        .showWarningMessage(vscode.l10n.t('apus · {0}: {1}', repo.name, troubleText(trouble, repo, flight)), ...actions)
        .then((answer) => {
          if (answer === showLog) {
            this.log.show(true);
          } else if (answer === fix) {
            void vscode.commands.executeCommand('apus.fixLast', repo.key);
          }
        });
      return;
    }

    if (!flight.committed && !flight.pushed) {
      // "nada que hacer": solo interesa si lo pidió el usuario.
      if (!auto) {
        void vscode.window.showInformationMessage(vscode.l10n.t('apus · {0}: {1}', repo.name, summary));
      }
      return;
    }
    if (auto && level !== 'all') {
      return;
    }

    const open = vscode.l10n.t('Open');
    const mute = vscode.l10n.t('Mute');
    // La URL del remoto, sin credenciales; la que imprime apus puede traerlas.
    const url = repo.browseUrl() ?? (flight.detail?.startsWith('https://') && !flight.detail.includes('@') ? flight.detail : undefined);
    const text = flight.committed
      ? vscode.l10n.t('apus · {0}: pushed {1} ({2})', repo.name, changes(count), summary)
      : vscode.l10n.t('apus · {0}: pushed pending commits ({1})', repo.name, summary);
    const actions = [...(url ? [open] : []), ...(auto ? [mute] : [])];
    void vscode.window.showInformationMessage(text, ...actions).then(async (answer) => {
      if (answer === open && url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (answer === mute) {
        await vscode.workspace.getConfiguration(SECTION).update('notifications', 'errors', vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(
          vscode.l10n.t('apus: from now on you will only be notified when something fails. You can change this in Rules.'),
        );
      }
    });
  }

  /** Subir a mano no llegó al remoto. */
  private offline(repo: RepoController, committed: boolean): void {
    const text = repo.watching
      ? vscode.l10n.t('apus · {0}: no connection to the remote. apus will try again on its own.', repo.name)
      : vscode.l10n.t('apus · {0}: no connection to the remote. Push again when you are back online.', repo.name);
    const saved = committed ? ` ${vscode.l10n.t('The commit is saved here.')}` : '';
    const showLog = vscode.l10n.t('Show Log');
    void vscode.window.showInformationMessage(text + saved, showLog).then((answer) => {
      if (answer === showLog) {
        this.log.show(true);
      }
    });
  }

  /** La carpeta de un repo desapareció: se avisa una vez, con cómo seguir. */
  missing(repo: RepoController): void {
    if (notifyLevel() === 'off') {
      return;
    }
    const locate = vscode.l10n.t('Locate Folder…');
    const forget = vscode.l10n.t('Forget');
    const entry = repo.asLost();
    void vscode.window
      .showWarningMessage(vscode.l10n.t('apus · {0}: the folder no longer exists ({1}).', repo.name, tildify(entry.path)), locate, forget)
      .then((answer) => {
        if (answer === locate) {
          void vscode.commands.executeCommand('apus.relocate', entry);
        } else if (answer === forget) {
          void vscode.commands.executeCommand('apus.forget', entry);
        }
      });
  }

  /** Un auto-commit no subió nada: la revisión encontró algo. Se avisa una vez por cada cosa nueva. */
  held(repo: RepoController, findings: readonly Finding[]): void {
    if (notifyLevel() === 'off' || findings.length === 0) {
      return;
    }
    const first = findings[0]!;
    const text = isSecret(first)
      ? vscode.l10n.t('apus · {0}: nothing was pushed. {1} looks like a secret ({2}).', repo.name, location(first), ruleText(first))
      : vscode.l10n.t('apus · {0}: nothing was pushed. {1} is too big ({2}).', repo.name, location(first), ruleText(first));
    const more = findings.length > 1 ? ` ${vscode.l10n.t('And {0} more.', findings.length - 1)}` : '';
    const review = vscode.l10n.t('Review…');
    void vscode.window.showWarningMessage(text + more, review).then((answer) => {
      if (answer === review) {
        void vscode.commands.executeCommand('apus.reviewHeld', repo.key);
      }
    });
  }

  /** En la carpeta ahora hay otro repo: apus dejó de vigilarla. */
  replaced(repo: RepoController): void {
    const watch = vscode.l10n.t('Watch');
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t(
          'apus · {0}: this folder now holds a different repository than the one you watched, so apus stopped watching it.',
          repo.name,
        ),
        watch,
      )
      .then((answer) => {
        if (answer === watch) {
          void repo.setWatching(true);
        }
      });
  }
}
