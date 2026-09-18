import * as vscode from 'vscode';
import type { ApusBinary } from '../apusBinary';
import type { Registry } from '../repos/registry';
import { countdown, LOGO, needsAttention, summary, tooltip, trustedMarkdown } from './describe';
import { binaryProblem, clock } from './text';

/**
 * El estado del repo activo, a la izquierda de la barra. Compacto a propósito:
 *
 *   ⌃ 10:48          vigilando, al día, último push a las 10:48
 *   ⌃ 3 · en 1:40    3 cambios, auto-commit en 1:40
 *   ⌃ ⏸ 3            en pausa
 *   ⌃ ⟳              subiendo
 *   ⌃ ⌁              sin URL a dónde subir
 *   ⌃ ☁ · en 1:40    sin conexión, vuelve a intentar en 1:40
 *   ⌃ ⚠              falló, no está la carpeta o no está apus (con fondo de advertencia)
 *
 * El detalle y las acciones están en el tooltip; un clic abre el menú.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('apus.status', vscode.StatusBarAlignment.Left, 10);
  private readonly subscriptions: vscode.Disposable[];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly registry: Registry,
    private readonly binary: ApusBinary,
  ) {
    this.item.name = 'Apus';
    this.subscriptions = [registry.onDidChange(() => this.render()), binary.onDidChange(() => this.render())];
    this.render();
  }

  private render(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const lookup = this.binary.state;
    if (lookup && !lookup.ok) {
      const md = trustedMarkdown();
      md.appendMarkdown('**apus** — ');
      md.appendText(binaryProblem(lookup.problem, lookup.path));
      md.appendMarkdown(
        `\n\n[$(tools) ${vscode.l10n.t('Fix…')}](command:apus.fixBinary) &nbsp;·&nbsp; [$(book) ${vscode.l10n.t('Get Started')}](command:apus.getStarted)`,
      );
      this.show(
        `$(${LOGO}) $(warning)`,
        md,
        { command: 'apus.fixBinary', title: vscode.l10n.t('Fix…') },
        true,
        vscode.l10n.t('apus is not available'),
      );
      return;
    }

    const c = this.registry.active;
    if (!c) {
      this.item.hide();
      return;
    }

    let text = `$(${LOGO})`;
    if (c.missing) {
      text += ' $(warning)';
    } else if (c.flying) {
      text += ' $(sync~spin)';
    } else if (c.held) {
      text += ' $(shield)';
    } else if (c.offline) {
      text += ' $(cloud)';
    } else if (c.lastError) {
      text += ' $(warning)';
    } else if (c.blocked === 'noRemote') {
      text += ' $(debug-disconnect)';
    } else if (!c.watching) {
      text += ' $(debug-pause)';
    } else if (c.blocked) {
      text += ' $(circle-slash)';
    }
    if (c.pending > 0 && !c.missing) {
      text += ` ${c.pending}`;
    }
    const next = countdown(c);
    if (next) {
      text += ` · ${next}`;
    } else if (c.watching && !c.flying && !c.lastError && !c.blocked && c.pending === 0 && c.lastPushAt !== undefined) {
      text += ` ${clock(c.lastPushAt)}`;
    }

    this.show(
      text,
      tooltip(c),
      { command: 'apus.menu', title: vscode.l10n.t('Menu'), arguments: [c.key] },
      needsAttention(c),
      `apus ${c.name}: ${summary(c)}`,
    );

    // Con cuenta regresiva, se actualiza cada segundo; si no, lo justo para que
    // los "hace 5 min" del tooltip no queden viejos.
    const delay = next ? 1000 - (Date.now() % 1000) + 10 : 30_000;
    this.timer = setTimeout(() => this.render(), delay);
  }

  private show(text: string, md: vscode.MarkdownString, command: vscode.Command, warning: boolean, label: string): void {
    this.item.text = text;
    this.item.tooltip = md;
    this.item.command = command;
    this.item.backgroundColor = warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.accessibilityInformation = { label };
    this.item.show();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.item.dispose();
  }
}
