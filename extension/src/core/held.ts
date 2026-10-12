// Lo que frenó la última subida. Recuerda con qué cambios se frenó: mientras no
// haya cambios nuevos ni se guarde un archivo, no tiene sentido volver a revisar
// en cada vuelo. Y recuerda qué se frenó, para avisar una sola vez por lo mismo.

import type { Finding } from './safety';
import { allowKey } from './stores';

export class HeldBack {
  private _findings: readonly Finding[] | undefined;
  private changes: string | undefined;
  private signature = '';

  /** Lo frenado, o undefined si nada. */
  get findings(): readonly Finding[] | undefined {
    return this._findings;
  }

  /** Frena con estos avisos y estos cambios. True si es algo que no estaba frenado. */
  hold(findings: readonly Finding[], changeSignature: string): boolean {
    const signature = findings.map(allowKey).sort().join('\n');
    const isNew = signature !== this.signature;
    this._findings = findings;
    this.changes = changeSignature;
    this.signature = signature;
    return isNew;
  }

  clear(): void {
    this._findings = undefined;
    this.changes = undefined;
    this.signature = '';
  }

  /** Se guardó un archivo: puede haber sacado el secreto, así que vale volver a revisar. */
  noteSave(): void {
    if (this._findings) {
      this.changes = undefined;
    }
  }

  /** ¿Sigue frenado? Mientras la lista de cambios sea la misma que cuando se frenó. */
  blocks(changeSignature: string): boolean {
    return this._findings !== undefined && this.changes === changeSignature;
  }
}
