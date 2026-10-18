import type { DisplayTransitionReader } from "../../src/features/observe/DisplayTransition";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { DisplayRef } from "../../src/models/DisplayPanel";

/** Full revisions deliberately differ from the public identity generations. */
export class FakeDisplayTransitionReader implements DisplayTransitionReader {
  fullRevision = 41;
  generation = 7;
  /** Starts at the current full revision, as a real tracker's fence equals its revision once any identity change is the latest event. */
  private lastIdentityChange = 41;
  panel: Pick<DisplayRef, "key" | "role"> | undefined = { key: "inner", role: "inner" };

  revision(_deviceId: string): number {
    return this.fullRevision;
  }
  identityRevision(_deviceId: string): number {
    return this.generation;
  }
  sameIdentitySince(_deviceId: string, renderedRevision: number): boolean {
    return renderedRevision >= this.lastIdentityChange && renderedRevision <= this.fullRevision;
  }
  currentObservedPanel(_deviceId: string) {
    return this.panel;
  }
  // Tests explicitly script detection; observation processing does not invent transitions.
  checkIdentity(_deviceId: string, _display: DisplayRef): boolean {
    return false;
  }
  record(_deviceId: string, _result: Pick<ObserveResult, "display" | "screenSize">): boolean {
    return false;
  }
  transition(count = 1, knownPanel = true): void {
    this.fullRevision += count;
    this.generation += count;
    this.lastIdentityChange = this.fullRevision;
    this.panel = knownPanel ? { key: "cover", role: "cover" } : undefined;
  }
  /** A geometry-only correction: advances the full revision but not the identity fence. */
  geometryTransition(count = 1): void {
    this.fullRevision += count;
  }
}
