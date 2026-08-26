import type { DiscoveryObservationSequence } from "../../src/utils/DiscoveryObservationSequence";

export class FakeDiscoveryObservationSequence implements DiscoveryObservationSequence {
  private value: number;

  constructor(initialValue: number = 0) {
    this.value = initialValue;
  }

  next(): number {
    this.value++;
    return this.value;
  }
}
