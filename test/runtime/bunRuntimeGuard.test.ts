import { describe, expect, test } from "bun:test";
import {
  enforceBunRuntime,
  unsupportedRuntimeMessage,
  type RuntimeGuardIo,
} from "../../src/runtime/bunRuntimeGuard";

function fakeIo(versions: RuntimeGuardIo["versions"]) {
  const stderr: string[] = [];
  const exits: number[] = [];
  const io: RuntimeGuardIo = {
    versions,
    writeStderr: (text) => stderr.push(text),
    exit: (code) => exits.push(code),
  };
  return { io, stderr, exits };
}

describe("bunRuntimeGuard", () => {
  test("allows Bun", () => {
    const { io, stderr, exits } = fakeIo({ bun: "1.3.14", node: "24.0.0" });
    expect(enforceBunRuntime(io)).toBe(true);
    expect(stderr).toEqual([]);
    expect(exits).toEqual([]);
  });

  test("Node prints a clear message and exits 1", () => {
    const { io, stderr, exits } = fakeIo({ node: "26.11.1" });
    expect(enforceBunRuntime(io)).toBe(false);
    expect(stderr.join("")).toContain("requires the Bun runtime");
    expect(stderr.join("")).toContain("Node.js 26.11.1");
    expect(stderr.join("")).toContain("bun dist/src/index.js");
    expect(exits).toEqual([1]);
  });

  test("unknown runtime still yields a message", () => {
    expect(unsupportedRuntimeMessage({})).toContain("this JavaScript runtime");
  });
});
