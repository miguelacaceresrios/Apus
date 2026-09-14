// Fechas y horas. Todo lo que se muestra usa el idioma de VS Code a través de
// Intl, así "hace 5 min" y "5 min ago" salen solos.

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-09-14 10:48", como el {date} de apus. No depende del idioma: va en el commit. */
export function formatStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** La hora si fue hoy ("10:48"); si no, también el día. */
export function formatClock(ms: number, locale: string, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) {
    return time;
  }
  return `${d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** "hace 5 min", "en 2 h", "ahora". */
export function formatRelative(ms: number, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const secs = (ms - now) / 1000;
  const abs = Math.abs(secs);
  if (abs < 45) {
    return rtf.format(0, 'second');
  }
  if (abs < 3600) {
    return rtf.format(Math.round(secs / 60), 'minute');
  }
  if (abs < 86_400) {
    return rtf.format(Math.round(secs / 3600), 'hour');
  }
  return rtf.format(Math.round(secs / 86_400), 'day');
}

/** Cuenta regresiva compacta: "1:40", "12:05", "1:02:00". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
