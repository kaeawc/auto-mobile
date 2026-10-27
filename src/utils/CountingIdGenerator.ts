import type { IdGenerator } from "./IdGenerator";

export class CountingIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string = "id") {}

  next(): string {
    this.counter++;
    return `${this.prefix}-${this.counter}`;
  }

  reset(): void {
    this.counter = 0;
  }
}
