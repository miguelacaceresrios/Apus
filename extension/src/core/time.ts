const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-09-14 10:48", como el {date} de apus. */
export function formatStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "10:48" si fue hoy; "13/09 10:48" si no. */
export function formatClock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

/** "hace 5 min", "en 2 min". */
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const future = diff > 0;
  const secs = Math.round(Math.abs(diff) / 1000);
  let text: string;
  if (secs < 45) {
    return future ? 'en unos segundos' : 'hace un momento';
  } else if (secs < 3600) {
    text = `${Math.max(1, Math.round(secs / 60))} min`;
  } else if (secs < 86_400) {
    text = `${Math.round(secs / 3600)} h`;
  } else {
    const days = Math.round(secs / 86_400);
    text = days === 1 ? '1 día' : `${days} días`;
  }
  return future ? `en ${text}` : `hace ${text}`;
}
