/** Incomplete broker journals must never admit a clean keep-booted reset. */
export interface MutationRecordingGaps {
  mark(sessionUuid: string, reason: string): void;
  reasonFor(sessionUuid: string): string | undefined;
  clear(sessionUuid: string): void;
}

export class InMemoryMutationRecordingGaps implements MutationRecordingGaps {
  private readonly reasons = new Map<string, string>();
  mark(sessionUuid: string, reason: string): void {
    if (!this.reasons.has(sessionUuid)) {
      this.reasons.set(sessionUuid, reason);
    }
  }
  reasonFor(sessionUuid: string): string | undefined {
    return this.reasons.get(sessionUuid);
  }
  clear(sessionUuid: string): void {
    this.reasons.delete(sessionUuid);
  }
}
