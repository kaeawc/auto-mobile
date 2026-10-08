import { FakeTimer } from "./FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const MAX_PUMPED_EVENTS = 5_000;

/**
 * A FakeTimer whose enableAutoAdvance() fires due events from a microtask-only pump
 * instead of FakeTimer's one-real-event-loop-turn-per-event dispatcher.
 *
 * The stock auto-advance spends a setImmediate per fake event, so on a starved CI
 * event loop a test's real 5 s budget can expire (or a fake deadline can win a race
 * against a response delivered on a real turn) while fake time is still crawling.
 * This pump waits for the fake timer state to go quiet over microtasks, then advances
 * to the next due event in due order, so its cost never grows with runner load.
 * Nothing is pumped before enableAutoAdvance().
 */
export class MicrotaskPumpFakeTimer extends FakeTimer {
  private pumpEnabled = false;
  private pumping = false;

  override enableAutoAdvance(): void {
    this.pumpEnabled = true;
    this.kick();
  }

  override sleep(ms: number): Promise<void> {
    const sleeping = super.sleep(ms);
    this.kick();
    return sleeping;
  }

  override setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = super.setTimeout(callback, ms);
    this.kick();
    return handle;
  }

  override setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = super.setInterval(callback, ms);
    this.kick();
    return handle;
  }

  private kick(): void {
    if (!this.pumpEnabled || this.pumping) {
      return;
    }
    this.pumping = true;
    queueMicrotask(() => void this.pump());
  }

  private async pump(): Promise<void> {
    try {
      for (let event = 0; event < MAX_PUMPED_EVENTS; event++) {
        // Hitting the drain cap only means work is still active; keep draining.
        await drainUntilQuiescent(this, { description: "pumped fake timer" }).catch(() => {});
        const delayMs = this.getMsUntilNextDueEvent();
        if (delayMs === undefined) {
          return;
        }
        this.advanceTime(delayMs);
      }
    } finally {
      this.pumping = false;
    }
  }
}
