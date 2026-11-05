import { describe, expect, test } from "bun:test";
import {
  type DataWrite,
  prototypeSensitiveSinkErrors,
  propagateDataTaint,
} from "../../../src/features/prototype/prototypeStrictPolicy";

const COPIES = 60;
const PER_BUTTON = 6;
const COMMON = 300;
const PERSISTED = [{ path: "storage.keys[0]", message: "Sensitive value cannot be persisted" }];

/** Copies listed destination-first: /cN <- /cN-1 ... /c1 <- /c0, with /c0 the paste target. */
function chainWrites(copies: number): DataWrite[] {
  return Array.from({ length: copies }, (_, i) => ({
    into: `/c${copies - i}`,
    source: "data",
    from: `/c${copies - i - 1}`,
  }));
}

/** Many copies sharing one `/common` source segment, plus one copy of the secret. */
function commonWrites(common: number): DataWrite[] {
  return [
    ...Array.from({ length: common }, (_, i): DataWrite => ({
      into: `/d${i}`,
      source: "data",
      from: `/common/x${i}`,
    })),
    { into: "/sink", source: "data", from: "/secret" },
  ];
}

function chainSpec(storageKey: string) {
  const buttons = Array.from({ length: COPIES / PER_BUTTON }, (_, i) => ({
    type: "button",
    label: `Copy ${i}`,
    onTap: chainWrites(COPIES)
      .slice(i * PER_BUTTON, (i + 1) * PER_BUTTON)
      .map((write) => ({
        type: "setData",
        path: `/data${write.into}`,
        value: { data: write.from },
      })),
  }));
  return {
    id: "chain",
    requires: { platform: ["clipboard"] },
    root: {
      type: "column",
      children: [{ type: "pasteButton", into: "/data/c0" }, ...buttons],
    },
    storage: { version: 1, keys: [storageKey] },
  };
}

/** Runs one propagation and returns the overlap checks it spent plus the final taint set. */
function propagate(seed: string, writes: DataWrite[]) {
  const tainted = [seed];
  const checks = propagateDataTaint(tainted, [], writes);
  return { checks, tainted };
}

describe("sensitive copy-taint propagation", () => {
  test("a reverse-ordered chain of copies taints its far end", () => {
    expect(prototypeSensitiveSinkErrors(chainSpec(`data:/c${COPIES}`))).toEqual(PERSISTED);
  });

  test("an unrelated destination stays untainted", () => {
    expect(prototypeSensitiveSinkErrors(chainSpec("data:/other"))).toEqual([]);
  });

  test("many copies sharing one source segment still taint the secret's copy", () => {
    const spec = {
      id: "common",
      requires: { platform: ["clipboard"] },
      root: {
        type: "column",
        children: [
          { type: "pasteButton", into: "/data/secret" },
          {
            type: "button",
            label: "Copy",
            onTap: commonWrites(COMMON).map((write) => ({
              type: "setData",
              path: `/data${write.into}`,
              value: { data: write.from },
            })),
          },
        ],
      },
      storage: { version: 1, keys: ["data:/sink"] },
    };
    expect(prototypeSensitiveSinkErrors(spec)).toEqual(PERSISTED);
  });

  // Scaling is asserted by counting overlap checks, not wall-clock time, so it holds on any runner.
  test("a reverse-ordered chain costs checks linear in its length", () => {
    const small = propagate("/c0", chainWrites(COPIES));
    const large = propagate("/c0", chainWrites(COPIES * 2));
    expect(small.tainted).toContain(`/c${COPIES}`);
    expect(large.tainted).toContain(`/c${COPIES * 2}`);
    expect(small.checks).toBe(COPIES);
    expect(large.checks).toBe(COPIES * 2);
  });

  test("copies sharing an untainted source segment cost no checks", () => {
    const small = propagate("/secret", commonWrites(COMMON));
    const large = propagate("/secret", commonWrites(COMMON * 10));
    expect(small.tainted).toEqual(["/secret", "/sink"]);
    expect(large.tainted).toEqual(["/secret", "/sink"]);
    expect(small.checks).toBe(1);
    expect(large.checks).toBe(1);
  });
});
