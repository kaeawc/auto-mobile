import type { IdGenerator } from "../../src/utils/IdGenerator";

export class FakeIdGenerator implements IdGenerator {
  private scripted: string[];
  private counter = 0;

  constructor(scripted: readonly string[] = []) {
    this.scripted = [...scripted];
  }

  setScripted(scripted: readonly string[]): void {
    this.scripted = [...scripted];
    this.counter = 0;
  }

  enqueue(id: string): void {
    this.scripted.push(id);
  }

  next(): string {
    const scripted = this.scripted.shift();
    if (scripted !== undefined) {
      return scripted;
    }
    this.counter++;
    return `fake-${this.counter}`;
  }

  pendingCount(): number {
    return this.scripted.length;
  }
}
