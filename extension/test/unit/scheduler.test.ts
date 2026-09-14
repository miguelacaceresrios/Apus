import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FlightScheduler, type Clock } from '../../src/core/scheduler';

/** Reloj falso: el tiempo avanza solo cuando el test lo pide. */
class FakeClock implements Clock {
  time = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;

  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    this.time = end;
  }
}

function setup(quietMs = 1000, minGapMs = 5000) {
  const clock = new FakeClock();
  const flights: number[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const scheduler = new FlightScheduler(
    () => {
      flights.push(clock.now());
      return hold ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
    },
    { quietMs, minGapMs },
    (e) => { throw e; },
    clock,
  );
  return {
    clock, flights, scheduler,
    holdFlights: () => { hold = true; },
    finishFlight: async () => { release?.(); await new Promise((r) => setImmediate(r)); },
  };
}

test('vuela cuando el repo queda quieto', async () => {
  const { clock, flights, scheduler } = setup();
  scheduler.poke();
  await clock.advance(999);
  assert.deepEqual(flights, []);
  await clock.advance(1);
  assert.deepEqual(flights, [1000]);
});

test('cada cambio reinicia la espera', async () => {
  const { clock, flights, scheduler } = setup();
  scheduler.poke();
  await clock.advance(800);
  scheduler.poke();
  await clock.advance(800);
  assert.deepEqual(flights, []);
  await clock.advance(200);
  assert.deepEqual(flights, [1800]);
});

test('respeta el mínimo entre vuelos', async () => {
  const { clock, flights, scheduler } = setup(1000, 5000);
  scheduler.poke();
  await clock.advance(1000);
  scheduler.poke();
  await clock.advance(2000);
  assert.deepEqual(flights, [1000]);
  await clock.advance(3000);
  assert.deepEqual(flights, [1000, 6000]);
});

test('un vuelo de otro proceso cuenta para el mínimo', async () => {
  const { clock, flights, scheduler } = setup(1000, 5000);
  clock.time = 10_000;
  scheduler.noteFlight(9_000);
  scheduler.poke();
  await clock.advance(1000);
  assert.deepEqual(flights, []);
  await clock.advance(3000);
  assert.deepEqual(flights, [14_000]);
});

test('cancel descarta el vuelo en espera', async () => {
  const { clock, flights, scheduler } = setup();
  scheduler.poke();
  assert.equal(scheduler.dueAt, 1000);
  scheduler.cancel();
  assert.equal(scheduler.dueAt, undefined);
  await clock.advance(10_000);
  assert.deepEqual(flights, []);
});

test('un cambio durante el vuelo programa otro al terminar', async () => {
  const { clock, flights, scheduler, holdFlights, finishFlight } = setup(1000, 0);
  holdFlights();
  scheduler.poke();
  await clock.advance(1000);
  scheduler.poke();
  scheduler.poke();
  assert.equal(scheduler.dueAt, undefined);
  await finishFlight();
  assert.equal(scheduler.dueAt, 2000);
  await clock.advance(1000);
  assert.deepEqual(flights, [1000, 2000]);
});

test('dispose frena todo', async () => {
  const { clock, flights, scheduler } = setup();
  scheduler.poke();
  scheduler.dispose();
  scheduler.poke();
  await clock.advance(10_000);
  assert.deepEqual(flights, []);
});
