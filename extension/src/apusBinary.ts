import * as vscode from 'vscode';
import { configuredBinary, SECTION } from './config';
import { findApus } from './core/binary';

/** Dónde está apus, y qué hacer cuando no está. */
export class ApusBinary implements vscode.Disposable {
  private warned = false;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.path`)) {
        this.warned = false;
      }
    });
  }

  /**
   * Busca apus en cada llamada (es barato, y así se entera si lo instalaste
   * después). Si no está, avisa: siempre si lo pidió el usuario, una sola vez
   * si fue un auto-commit.
   */
  async get(interactive: boolean): Promise<string | undefined> {
    const lookup = await findApus(configuredBinary());
    if (lookup.ok) {
      return lookup.path;
    }
    this.log.warn(`apus: ${lookup.reason}`);
    if (interactive || !this.warned) {
      this.warned = true;
      void this.explain(lookup.reason);
    }
    return undefined;
  }

  async choose(): Promise<void> {
    const windows = process.platform === 'win32';
    const picked = await vscode.window.showOpenDialog({
      title: 'Elegí el binario de apus',
      openLabel: 'Usar este',
      canSelectMany: false,
      filters: windows ? { 'apus.exe': ['exe'] } : undefined,
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }
    await vscode.workspace.getConfiguration(SECTION).update('path', file.fsPath, vscode.ConfigurationTarget.Global);
    const lookup = await findApus(file.fsPath);
    if (lookup.ok) {
      void vscode.window.showInformationMessage(`apus: listo, uso ${lookup.path}`);
    } else {
      void vscode.window.showErrorMessage(`apus: ${lookup.reason}`);
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private async explain(reason: string): Promise<void> {
    const choose = 'Elegir apus…';
    const settings = 'Abrir ajuste';
    const answer = await vscode.window.showErrorMessage(`apus: ${reason}.`, choose, settings);
    if (answer === choose) {
      await this.choose();
    } else if (answer === settings) {
      await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.path`);
    }
  }
}
