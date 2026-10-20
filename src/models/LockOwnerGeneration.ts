export type LockOwnerGenerationVerdict = "same" | "different" | "unknown";
export interface LockOwnerGenerationProbe {
  /** Token for a lock pid is taking now; undefined when unavailable. Must not throw. */
  current(pid: number): string | undefined;
  /** Compare a live pid with its recorded token; unknown means unreadable/incomparable. Must not throw. */
  compare(pid: number, recorded: string): LockOwnerGenerationVerdict;
}
