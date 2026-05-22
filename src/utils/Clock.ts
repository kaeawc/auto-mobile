export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}

export const systemClock: Clock = new SystemClock();

export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date | string | number = 0) {
    this.current = normalizeDate(initial);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  nowMs(): number {
    return this.current.getTime();
  }

  nowIso(): string {
    return this.current.toISOString();
  }

  setNow(value: Date | string | number): void {
    this.current = normalizeDate(value);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new Error(`FakeClock.advance expected a finite millisecond value, got ${ms}`);
    }
    this.current = new Date(this.current.getTime() + ms);
  }
}

const normalizeDate = (value: Date | string | number): Date => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  return new Date(value);
};
