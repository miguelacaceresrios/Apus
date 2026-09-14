import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatClock, formatCountdown, formatRelative, formatStamp } from '../../src/core/time';

const now = new Date(2026, 8, 14, 12, 0, 0).getTime();
const min = 60_000;

test('formatStamp no depende del idioma', () => {
  assert.equal(formatStamp(new Date(2026, 0, 2, 3, 4)), '2026-01-02 03:04');
});

test('formatRelative habla el idioma de VS Code', () => {
  assert.equal(formatRelative(now - 5 * min, 'es', now), 'hace 5 min');
  assert.equal(formatRelative(now + 2 * 60 * min, 'es', now), 'dentro de 2 h');
  assert.equal(formatRelative(now - 5 * min, 'en', now), '5 min. ago');
  assert.equal(formatRelative(now - 10_000, 'en', now), 'now');
});

test('formatClock agrega el día solo si no fue hoy', () => {
  const today = formatClock(now - 30 * min, 'es', now);
  assert.match(today, /^11:30$/);
  const yesterday = formatClock(now - 24 * 60 * min, 'es', now);
  // Cada idioma decide cómo escribe el día: "13/9" en español.
  assert.match(yesterday, /^13\/0?9 12:00$/);
});

test('formatCountdown', () => {
  assert.equal(formatCountdown(100_000), '1:40');
  assert.equal(formatCountdown(999), '0:01');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(formatCountdown(3_720_000), '1:02:00');
});
