import * as vscode from 'vscode';
import { notifyLevel, SECTION } from '../config';
import type { FlightReport } from '../repos/repoController';
import { changes, flightSummary } from './text';

/** Avisos de VS Code en lugar de notify-send, según apus.notifications. */
export class Notifier {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  /**
   * Muestra el desenlace de un vuelo. Lo manual siempre se informa; lo
   * automático, según el ajuste, y un error repetido no se vuelve a avisar.
   */
  report({ repo, kind, flight, changes: count }: FlightReport, repeatedError: boolean): void {
    const level = notifyLevel();
    const auto = kind === 'auto';
    const summary = flightSummary(flight);

    if (!flight.ok) {
      if (auto && (level === 'off' || repeatedError)) {
        return;
      }
      const showLog = vscode.l10n.t('Show log');
      const text = flight.detail ? `${summary}. ${flight.detail}` : summary;
      void vscode.window.showWarningMessage(vscode.l10n.t('apus · {0}: {1}', repo.name, text), showLog).then((answer) => {
        if (answer === showLog) {
          this.log.show(true);
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
    const url = flight.detail?.startsWith('https://') ? flight.detail : repo.browseUrl();
    const text = flight.committed
      ? vscode.l10n.t('apus · {0}: pushed {1} ({2})', repo.name, changes(count), summary)
      : vscode.l10n.t('apus · {0}: pushed pending commits ({1})', repo.name, summary);
    const actions = [...(url ? [open] : []), ...(auto ? [mute] : [])];
    void vscode.window.showInformationMessage(text, ...actions).then(async (answer) => {
      if (answer === open && url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (answer === mute) {
        await vscode.workspace.getConfiguration(SECTION).update('notifications', 'errors', vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(vscode.l10n.t('apus: from now on you will only be notified when something fails. You can change this in Rules.'));
      }
    });
  }
}
