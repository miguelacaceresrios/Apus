import * as vscode from 'vscode';
import { configuredBinary, SECTION } from './config';
import { findApus, type BinaryLookup } from './core/binary';
import { binaryProblem } from './ui/text';

/** Instrucciones de instalación de apus. Cuando apus publique releases, conviene apuntar a /releases/latest. */
export const APUS_DOWNLOAD_URL = 'https://github.com/miguelacaceresrios/Apus#instalación';

/**
 * Dónde está apus. Se busca al arrancar, al cambiar apus.path y al volver a la
 * ventana, así la barra y la vista avisan antes del primer push, y se enteran
 * solas si lo instalaste con VS Code abierto.
 */
export class ApusBinary implements vscode.Disposable {
  private _state: BinaryLookup | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[];

  readonly onDidChange = this.emitter.event;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.disposables = [
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.path`)) {
          void this.refresh();
        }
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && this._state?.ok === false) {
          void this.refresh();
        }
      }),
    ];
  }

  /** Undefined hasta la primera búsqueda. */
  get state(): BinaryLookup | undefined {
    return this._state;
  }

  async refresh(): Promise<BinaryLookup> {
    const next = await findApus(configuredBinary());
    const changed = JSON.stringify(next) !== JSON.stringify(this._state);
    this._state = next;
    if (changed) {
      void vscode.commands.executeCommand('setContext', 'apus.binaryFound', next.ok);
      void vscode.commands.executeCommand('setContext', 'apus.binaryMissing', !next.ok);
      if (next.ok) {
        this.log.info(`apus binary: ${next.path}`);
      } else {
        this.log.warn(`apus binary not available: ${next.problem}${next.path ? ` (${next.path})` : ''}`);
      }
      this.emitter.fire();
    }
    return next;
  }

  /** Ruta de apus. Si no está y lo pidió el usuario, ofrece arreglarlo. */
  async get(interactive: boolean): Promise<string | undefined> {
    const state = await this.refresh();
    if (state.ok) {
      return state.path;
    }
    if (interactive) {
      void this.offerFix();
    }
    return undefined;
  }

  async offerFix(): Promise<void> {
    const state = await this.refresh();
    if (state.ok) {
      void vscode.window.showInformationMessage(vscode.l10n.t('apus is ready: {0}', state.path));
      return;
    }
    const choose = vscode.l10n.t('Choose apus…');
    const download = vscode.l10n.t('Download apus');
    const guide = vscode.l10n.t('Open guide');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('apus: {0}.', binaryProblem(state.problem, state.path)),
      choose,
      download,
      guide,
    );
    if (answer === choose) {
      await this.choose();
    } else if (answer === download) {
      await vscode.env.openExternal(vscode.Uri.parse(APUS_DOWNLOAD_URL));
    } else if (answer === guide) {
      await vscode.commands.executeCommand('apus.getStarted');
    }
  }

  async choose(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Choose the apus binary'),
      openLabel: vscode.l10n.t('Use this one'),
      canSelectMany: false,
      filters: process.platform === 'win32' ? { 'apus.exe': ['exe'] } : undefined,
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }
    await vscode.workspace.getConfiguration(SECTION).update('path', file.fsPath, vscode.ConfigurationTarget.Global);
    const state = await this.refresh();
    if (state.ok) {
      void vscode.window.showInformationMessage(vscode.l10n.t('apus is ready: {0}', state.path));
    } else {
      void vscode.window.showErrorMessage(vscode.l10n.t('apus: {0}.', binaryProblem(state.problem, state.path)));
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
