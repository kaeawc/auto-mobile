import type {
  LockOwnerGenerationProbe,
  LockOwnerGenerationVerdict,
} from "../../src/utils/fileLock";

export class FakeLockOwnerGenerationProbe implements LockOwnerGenerationProbe {
  token: string | undefined = "linux:boot:new";
  verdict: LockOwnerGenerationVerdict = "unknown";
  currentError?: Error;
  compareError?: Error;
  onCurrent?: (pid: number) => void;
  onCompare?: (pid: number, recorded: string) => LockOwnerGenerationVerdict;
  currentCalls: number[] = [];
  compareCalls: { pid: number; recorded: string }[] = [];

  current(pid: number): string | undefined {
    this.currentCalls.push(pid);
    this.onCurrent?.(pid);
    if (this.currentError) {
      throw this.currentError;
    }
    return this.token;
  }

  compare(pid: number, recorded: string): LockOwnerGenerationVerdict {
    this.compareCalls.push({ pid, recorded });
    if (this.compareError) {
      throw this.compareError;
    }
    return this.onCompare?.(pid, recorded) ?? this.verdict;
  }
}
