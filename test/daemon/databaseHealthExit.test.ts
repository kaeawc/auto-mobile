import { describe, expect, test } from "bun:test";
import {
  databaseHealthExitMessage,
  exitAfterDatabaseHealthFailure,
  type DatabaseHealthExitDeps,
} from "../../src/daemon/databaseHealthExit";

const FIXED_NOW_MS = Date.UTC(2026, 9, 12, 15, 9, 54);

class FakeDatabaseHealthExitDeps implements DatabaseHealthExitDeps {
  calls: string[] = [];
  messages: string[] = [];
  nowCalls = 0;
  now(): number {
    this.nowCalls += 1;
    return FIXED_NOW_MS;
  }
  writeEmergency(message: string): void {
    this.calls.push("emergency");
    this.messages.push(message);
  }
  cleanupDaemonFiles(): void {
    this.calls.push("cleanup");
  }
  async closeLogger(): Promise<void> {
    this.calls.push("closeLogger");
  }
  exit(code: number): void {
    this.calls.push(`exit:${code}`);
  }
}

describe("database health exit", () => {
  test("writes the emergency diagnostic before cleanup, logger close and exit", async () => {
    const deps = new FakeDatabaseHealthExitDeps();
    const detail = "Database health probe timed out after 1000ms";

    await exitAfterDatabaseHealthFailure(1, detail, deps);

    expect(deps.calls).toEqual(["emergency", "cleanup", "closeLogger", "exit:1"]);
    expect(deps.nowCalls).toBe(1);
    expect(deps.messages).toEqual([databaseHealthExitMessage(1, detail, FIXED_NOW_MS)]);
    expect(deps.messages[0]).toBe(
      "2026-10-12T15:09:54.000Z [ERROR] [Daemon] exiting with code 1: database health check failed repeatedly; last failure: Database health probe timed out after 1000ms",
    );
  });

  test("writes the diagnostic before the logger flush settles", async () => {
    const deps = new FakeDatabaseHealthExitDeps();
    let release!: () => void;
    deps.closeLogger = () => {
      deps.calls.push("closeLogger");
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const exiting = exitAfterDatabaseHealthFailure(1, undefined, deps);

    expect(deps.calls).toEqual(["emergency", "cleanup", "closeLogger"]);
    expect(deps.messages).toEqual([databaseHealthExitMessage(1, undefined, FIXED_NOW_MS)]);
    release();
    await exiting;
    expect(deps.calls).toEqual(["emergency", "cleanup", "closeLogger", "exit:1"]);
  });

  test("exits with the requested code and rejects when logger close rejects", async () => {
    const deps = new FakeDatabaseHealthExitDeps();
    const error = new Error("flush failed");
    deps.closeLogger = async () => {
      deps.calls.push("closeLogger");
      throw error;
    };

    await expect(exitAfterDatabaseHealthFailure(7, undefined, deps)).rejects.toBe(error);

    expect(deps.calls).toEqual(["emergency", "cleanup", "closeLogger", "exit:7"]);
  });

  test("continues cleanup, logger close and exit when emergency logging throws", async () => {
    const deps = new FakeDatabaseHealthExitDeps();
    deps.writeEmergency = () => {
      deps.calls.push("emergency");
      throw new Error("stderr unavailable");
    };

    await exitAfterDatabaseHealthFailure(1, undefined, deps);

    expect(deps.calls).toEqual(["emergency", "cleanup", "closeLogger", "exit:1"]);
  });

  test("omits absent detail and replaces carriage returns and newlines with spaces", () => {
    expect(databaseHealthExitMessage(1, undefined, FIXED_NOW_MS)).toBe(
      "2026-10-12T15:09:54.000Z [ERROR] [Daemon] exiting with code 1: database health check failed repeatedly",
    );
    expect(databaseHealthExitMessage(1, "first\r\nsecond\nthird\rfourth", FIXED_NOW_MS)).toBe(
      "2026-10-12T15:09:54.000Z [ERROR] [Daemon] exiting with code 1: database health check failed repeatedly; last failure: first  second third fourth",
    );
  });
});
