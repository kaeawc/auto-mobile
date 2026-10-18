import type { DisplayTransitionReader } from "../../src/features/observe/DisplayTransition";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { DisplayRef } from "../../src/models/DisplayPanel";

type ObservedPanel = Pick<DisplayRef, "key" | "role">;

interface DeviceTransitionState {
  full: number;
  generation: number;
  /** Full revision of the most recent identity (panel/posture) change. */
  lastIdentityChange: number;
  panel: ObservedPanel | undefined;
}

/**
 * Full revisions deliberately differ from the public identity generations.
 *
 * `fullRevision`, `generation` and `panel` are the state of every device that was never
 * driven by id, which is what the single-device action tests mutate directly. Driving a
 * device by id (`transition(.., deviceId)`, `resize`, `observe`) gives it independent state,
 * like the real tracker's per-device maps. Behaviour is pinned to DisplayTransitionTracker
 * by the shared DisplayTransitionReader contract.
 */
export class FakeDisplayTransitionReader implements DisplayTransitionReader {
  private readonly base: DeviceTransitionState = {
    full: 41,
    generation: 7,
    lastIdentityChange: 0,
    panel: { key: "inner", role: "inner" },
  };
  private readonly byDevice = new Map<string, DeviceTransitionState>();

  get fullRevision(): number {
    return this.base.full;
  }
  set fullRevision(value: number) {
    this.base.full = value;
  }
  get generation(): number {
    return this.base.generation;
  }
  set generation(value: number) {
    this.base.generation = value;
  }
  get panel(): ObservedPanel | undefined {
    return this.base.panel;
  }
  set panel(value: ObservedPanel | undefined) {
    this.base.panel = value;
  }

  private state(deviceId: string): DeviceTransitionState {
    return this.byDevice.get(deviceId) ?? this.base;
  }

  private drive(deviceId?: string): DeviceTransitionState {
    if (deviceId === undefined) {
      return this.base;
    }
    let state = this.byDevice.get(deviceId);
    if (!state) {
      state = { ...this.base };
      this.byDevice.set(deviceId, state);
    }
    return state;
  }

  revision(deviceId: string): number {
    return this.state(deviceId).full;
  }
  identityRevision(deviceId: string): number {
    return this.state(deviceId).generation;
  }
  sameIdentitySince(deviceId: string, renderedRevision: number): boolean {
    const state = this.state(deviceId);
    return renderedRevision >= state.lastIdentityChange && renderedRevision <= state.full;
  }
  currentObservedPanel(deviceId: string): ObservedPanel | undefined {
    return this.state(deviceId).panel;
  }
  // Tests explicitly script detection; observation processing does not invent transitions.
  checkIdentity(_deviceId: string, _display: DisplayRef): boolean {
    return false;
  }
  record(_deviceId: string, _result: Pick<ObserveResult, "display" | "screenSize">): boolean {
    return false;
  }
  /** An identity transition; the panel is the cover one unless it is not yet re-observed. */
  transition(count = 1, knownPanel = true, deviceId?: string): void {
    const state = this.drive(deviceId);
    state.full += count;
    state.generation += count;
    state.lastIdentityChange = state.full;
    state.panel = knownPanel ? { key: "cover", role: "cover" } : undefined;
  }
  /** A geometry-only change within one observation: it fences revisions, not identity. */
  resize(deviceId?: string): void {
    this.drive(deviceId).full += 1;
  }
  /** A fresh observation accepted a panel at the current revision. */
  observe(panel: ObservedPanel, deviceId?: string): void {
    this.drive(deviceId).panel = { key: panel.key, role: panel.role };
  }
}
