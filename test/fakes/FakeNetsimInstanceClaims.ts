import type { NetsimInstanceClaims } from "../../src/utils/android-cmdline-tools/NetsimInstanceClaims";

/** In-memory claims; `foreign` paths model locks held by another AutoMobile process. */
export class FakeNetsimInstanceClaims implements NetsimInstanceClaims {
  readonly held = new Set<string>();
  readonly foreign = new Set<string>();
  readonly released: string[] = [];

  tryClaim(lockPath: string): boolean {
    if (this.held.has(lockPath) || this.foreign.has(lockPath)) {
      return false;
    }
    this.held.add(lockPath);
    return true;
  }

  release(lockPath: string): void {
    this.held.delete(lockPath);
    this.released.push(lockPath);
  }
}
