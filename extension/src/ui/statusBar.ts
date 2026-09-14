import * as vscode from 'vscode';
import { formatClock } from '../core/time';
import type { Registry } from '../repos/registry';
import { look, tooltip } from './describe';

/** El estado del repo activo, a la izquierda de la barra. Un clic abre el menú. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('apus.status', vscode.StatusBarAlignment.Left, 10);
  private readonly subscription: vscode.Disposable;
  // Los "hace 5 min" del tooltip envejecen solos.
  private readonly timer = setInterval(() => this.render(), 30_000);

  constructor(private readonly registry: Registry) {
    this.item.name = 'Apus';
    this.item.command = 'apus.menu';
    this.subscription = registry.onDidChange(() => this.render());
    this.render();
  }

  private render(): void {
    const c = this.registry.active;
    if (!c) {
      this.item.hide();
      return;
    }
    let text = `$(${look(c).icon}) apus`;
    if (c.pending > 0) {
      text += ` $(diff-modified) ${c.pending}`;
    }
    if (c.lastPushAt !== undefined) {
      text += ` $(cloud-upload) ${formatClock(c.lastPushAt)}`;
    }
    this.item.text = text;
    this.item.tooltip = tooltip(c);
    this.item.backgroundColor = c.lastError ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.subscription.dispose();
    this.item.dispose();
  }
}
