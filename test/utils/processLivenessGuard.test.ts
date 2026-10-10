import { describe, expect, test } from "bun:test";
import { isProcessRunning } from "../../src/utils/processLiveness";

describe("isProcessRunning guard", () => {
  test.each([0, -1, -42, 1.5, Number.NaN])("never probes the non-PID %p", (pid) => {
    const probed: number[] = [];
    expect(isProcessRunning(pid, { signalProcess: (p) => void probed.push(p) })).toBe(false);
    expect(probed).toEqual([]);
  });

  test("probes a positive PID", () => {
    const probed: number[] = [];
    expect(isProcessRunning(7, { signalProcess: (p) => void probed.push(p) })).toBe(true);
    expect(probed).toEqual([7]);
  });
});
