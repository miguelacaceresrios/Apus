// Cuándo volar. Espera a que el repo quede quieto un rato y respeta un mínimo
// entre vuelos. No sabe nada de git ni de VS Code: recibe avisos y llama a `fly`.

export interface SchedulerOptions {
  /** Milisegundos sin cambios nuevos antes de volar. */
  quietMs: number;
  /** Milisegundos mínimos entre el comienzo de dos vuelos. */
  minGapMs: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const RETRY_MINUTES = [1, 2, 5, 10];

/**
 * Cuánto esperar antes de volver a intentar un push que falló sin conexión:
 * 1, 2 y 5 minutos, y después cada 10. `attempt` empieza en 0.
 */
export function retryDelayMs(attempt: number): number {
  return RETRY_MINUTES[Math.min(Math.max(0, attempt), RETRY_MINUTES.length - 1)]! * 60_000;
}

export class FlightScheduler {
  private timer: unknown;
  private flying = false;
  private pokedWhileFlying = false;
  private disposed = false;
  private lastFlightAt: number | undefined;
  private due: number | undefined;

  constructor(
    private readonly fly: () => Promise<void>,
    private options: SchedulerOptions,
    private readonly onError: (error: unknown) => void,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Momento previsto del próximo vuelo, si hay uno en espera. */
  get dueAt(): number | undefined {
    return this.due;
  }

  /** Hubo cambios: reinicia la espera. */
  poke(): void {
    if (this.disposed) {
      return;
    }
    if (this.flying) {
      this.pokedWhileFlying = true;
      return;
    }
    this.schedule();
  }

  /** Ya no queda nada que subir. */
  cancel(): void {
    this.clear();
    this.pokedWhileFlying = false;
  }

  /** Otro proceso (u otro camino) voló en `at`: cuenta para el mínimo entre vuelos. */
  noteFlight(at: number): void {
    if (this.lastFlightAt === undefined || at > this.lastFlightAt) {
      this.lastFlightAt = at;
      if (this.due !== undefined) {
        this.schedule();
      }
    }
  }

  setOptions(options: SchedulerOptions): void {
    this.options = options;
    if (this.due !== undefined) {
      this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private schedule(): void {
    this.clear();
    const now = this.clock.now();
    const earliest = this.lastFlightAt === undefined ? now : this.lastFlightAt + this.options.minGapMs;
    const at = Math.max(now + this.options.quietMs, earliest);
    this.due = at;
    this.timer = this.clock.setTimeout(() => {
      this.fire().catch(this.onError);
    }, at - now);
  }

  private clear(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.due = undefined;
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    this.due = undefined;
    this.flying = true;
    this.pokedWhileFlying = false;
    this.lastFlightAt = this.clock.now();
    try {
      await this.fly();
    } finally {
      this.flying = false;
      if (this.pokedWhileFlying && !this.disposed) {
        this.schedule();
      }
    }
  }
}
