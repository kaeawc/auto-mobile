import { randomUUID } from "node:crypto";

export interface IdGenerator {
  next(): string;
}

export class NodeIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

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

export const defaultIdGenerator: IdGenerator = new NodeIdGenerator();
