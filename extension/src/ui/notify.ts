import * as vscode from 'vscode';
import { notifyLevel, SECTION } from '../config';
import type { FlightReport } from '../repos/repoController';
import { plural } from './describe';

/** Avisos de VS Code en lugar de notify-send, según apus.notifications. */
export class Notifier {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  /**
   * Muestra el desenlace de un vuelo. Lo manual siempre se informa; lo
   * automático, según el ajuste, y un error repetido no se vuelve a avisar.
   */
  report({ repo, kind, flight, changes }: FlightReport, repeatedError: boolean): void {
    const level = notifyLevel();
    const auto = kind === 'auto';

    if (!flight.ok) {
      if (auto && (level === 'off' || repeatedError)) {
        return;
      }
      const text = flight.detail ? `${flight.summary}. ${flight.detail}` : flight.summary;
      void this.ask('warn', `apus · ${repo.name}: ${text}`, ['Ver registro']).then((answer) => {
        if (answer) {
          this.log.show(true);
        }
      });
      return;
    }

    if (!flight.committed && !flight.pushed) {
      // "nada que hacer": solo interesa si lo pidió el usuario.
      if (!auto) {
        void vscode.window.showInformationMessage(`apus · ${repo.name}: ${flight.summary}`);
      }
      return;
    }
    if (auto && level !== 'all') {
      return;
    }

    const what = flight.committed ? `subí ${plural(changes, 'cambio', 'cambios')}` : 'subí los commits pendientes';
    const url = flight.detail?.startsWith('https://') ? flight.detail : repo.browseUrl();
    const actions = [...(url ? ['Abrir'] : []), ...(auto ? ['Silenciar'] : [])];
    void this.ask('info', `apus · ${repo.name}: ${what} (${flight.summary})`, actions).then(async (answer) => {
      if (answer === 'Abrir' && url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (answer === 'Silenciar') {
        await vscode.workspace.getConfiguration(SECTION).update('notifications', 'errors', vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage('apus: solo te aviso cuando algo falle. Se cambia en Reglas.');
      }
    });
  }

  private ask(kind: 'info' | 'warn', text: string, actions: string[]): Thenable<string | undefined> {
    return kind === 'info'
      ? vscode.window.showInformationMessage(text, ...actions)
      : vscode.window.showWarningMessage(text, ...actions);
  }
}
