import type { IdGenerator } from "../../src/utils/IdGenerator";

export class FakeIdGenerator implements IdGenerator {
  private scripted: string[];
  private counter = 0;

  constructor(scripted: readonly string[] = []) {
    this.scripted = [...scripted];
  }

  setScripted(scripted: readonly string[]): void {
    // Replace the queued scripted ids but DO NOT reset the fallback counter:
    // resetting it re-emits `fake-1` after the new script drains, colliding with
    // an id this generator already handed out earlier in the test. The generator
    // must stay unique across its whole lifetime (issue #4186).
    this.scripted = [...scripted];
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
