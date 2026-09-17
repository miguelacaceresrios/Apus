// La URL a la que sube un repo: validarla como apus, elegir el remoto y
// mostrarla corta.

import * as path from 'node:path';

export type UrlCheck =
  | { ok: true; url: string }
  /** `suggestion`: la misma URL con https:// adelante, si parece que faltaba. */
  | { ok: false; problem: 'empty' | 'invalid'; suggestion?: string };

/**
 * Acepta lo que git entiende como remoto: https, ssh, git@host:ruta, file:// o
 * la ruta absoluta a un repo local. Igual que la ventana de apus.
 */
export function checkRemoteUrl(raw: string): UrlCheck {
  const url = raw.trim();
  if (!url) {
    return { ok: false, problem: 'empty' };
  }
  if (/\s/.test(url)) {
    return { ok: false, problem: 'invalid' };
  }
  if (/^(https?|ssh|git|file):\/\/\S/i.test(url) || /^[\w.-]+@[\w.-]+:\S/.test(url)) {
    return { ok: true, url };
  }
  if (path.isAbsolute(url) || path.win32.isAbsolute(url)) {
    return { ok: true, url };
  }
  // "github.com/usuario/repo": falta el esquema.
  if (/^[\w-]+(\.[\w-]+)+\/[^/]+\/[^/]+/.test(url)) {
    return { ok: false, problem: 'invalid', suggestion: `https://${url}` };
  }
  return { ok: false, problem: 'invalid' };
}

/**
 * El remoto al que sube apus: el de la rama si tiene upstream, si no origin,
 * si no el único que haya. Undefined si no hay ninguno o no se puede elegir.
 */
export function chooseRemote(names: readonly string[], upstreamRemote: string | undefined): string | undefined {
  if (upstreamRemote && names.includes(upstreamRemote)) {
    return upstreamRemote;
  }
  if (names.includes('origin')) {
    return 'origin';
  }
  return names.length === 1 ? names[0] : undefined;
}

/**
 * "github.com/usuario/repo" para mostrar. Nunca muestra usuario ni clave, aunque
 * vengan en la URL.
 */
export function shortUrl(url: string): string {
  let u = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.*)$/.exec(u);
  if (scp) {
    u = `${scp[1]}/${scp[2]}`;
  } else {
    u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^/@]*@/, '');
  }
  return u.replace(/\/$/, '').replace(/\.git$/, '');
}

/**
 * Tapa las credenciales de las URLs que aparezcan en un texto:
 * "https://usuario:token@github.com" → "https://***@github.com". apus imprime la
 * URL del remoto tal cual, y ese texto va al registro y a los avisos. Un usuario
 * solo, como el "git" de ssh://git@github.com, se deja.
 */
export function redactCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, (whole, scheme: string, userinfo: string) =>
    userinfo.includes(':') || userinfo.length >= 20 ? `${scheme}***@` : whole,
  );
}
