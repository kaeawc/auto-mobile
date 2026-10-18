import { ChildProcess } from "node:child_process";

/**
 * A cold-boot process handle that is a real `ChildProcess` subclass (never spawned), so it
 * type-checks wherever production takes a `ChildProcess` and tests need no cast.
 *
 * Tests script `pid` / `exitCode` / `signalCode` / `kill` by overriding, and emit `"exit"`
 * through the inherited `EventEmitter` surface.
 */
export class FakeColdBootProcess extends ChildProcess {
  override readonly pid: number = 4242;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  override killed = false;
  // Own data properties: Bun's unspawned `ChildProcess` serves these through accessors that
  // read a native handle this fake never has.
  override stdin = null;
  override stdout = null;
  override stderr = null;
  override stdio: ChildProcess["stdio"] = [null, null, null, null, null];

  override kill(): boolean {
    this.killed = true;
    return true;
  }
}
