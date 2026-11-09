import { describe, expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/library-sensitive/repeat-item-copy.json";
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

/** Hops /c0 -> k1 -> /c1 -> ... -> kN -> /cN through state keys, listed destination-first. */
function stateChainWrites(copies: number): DataWrite[] {
  return Array.from({ length: copies }, (_, i): DataWrite[] => {
    const at = copies - i;
    return [
      { into: `/c${at}`, source: "state", from: `k${at}` },
      { into: `k${at}`, intoState: true, source: "data", from: `/c${at - 1}` },
    ];
  }).flat();
}

/** Many state copies of unrelated keys, plus one state hop of the secret. */
function commonStateWrites(common: number): DataWrite[] {
  return [
    ...Array.from({ length: common }, (_, i): DataWrite => ({
      into: `/d${i}`,
      source: "state",
      from: `other${i}`,
    })),
    { into: "secretKey", intoState: true, source: "data", from: "/secret" },
    { into: "/sink", source: "state", from: "secretKey" },
  ];
}

/** A platform read set into `u`, then the sink fields given; library flagged with auth. */
function stateSinkSpec(send: Record<string, unknown>, storageKeys: string[] = []) {
  return {
    id: "state-sink",
    requires: { platform: ["auth"] },
    state: { u: "" },
    root: {
      type: "column",
      children: [
        {
          type: "button",
          label: "Copy",
          onTap: [{ type: "setState", key: "u", value: { platform: "/auth/userId" } }],
        },
        {
          type: "button",
          label: "Send",
          onTap: [{ type: "request", url: "https://example.com/submit", via: "device", ...send }],
        },
      ],
    },
    ...(storageKeys.length ? { storage: { version: 1, keys: storageKeys } } : {}),
  };
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
  test.each(["setData", "appendData", "prependData", "upsertData"])(
    "%s copies a tainted repeat item to a request outside the repeat",
    (type) => {
      const spec = structuredClone(fixture.spec);
      const write = spec.root.children[1].children?.[0].onTap[0];
      if (!write) {
        throw new Error("Missing repeat item write in shared fixture");
      }
      write.type = type;
      expect(prototypeSensitiveSinkErrors(spec)).toEqual([
        { path: fixture.expectedPath, message: fixture.expectedMessage },
      ]);
    },
  );

  test("an item over unrelated rows leaves its copy untainted", () => {
    const spec = structuredClone(fixture.spec);
    spec.root.children[0].into = "/data/other";
    expect(prototypeSensitiveSinkErrors(spec)).toEqual([]);
  });

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

  test("a reverse-ordered chain through state keys costs checks linear in its length", () => {
    const small = propagate("/c0", stateChainWrites(COPIES));
    const large = propagate("/c0", stateChainWrites(COPIES * 2));
    expect(small.tainted).toContain(`/c${COPIES}`);
    expect(large.tainted).toContain(`/c${COPIES * 2}`);
    expect(small.checks).toBe(COPIES * 2);
    expect(large.checks).toBe(COPIES * 4);
  });

  test("state copies of unrelated keys cost no checks", () => {
    const small = propagate("/secret", commonStateWrites(COMMON));
    const large = propagate("/secret", commonStateWrites(COMMON * 10));
    expect(small.tainted).toEqual(["/secret", "/sink"]);
    expect(large.tainted).toEqual(["/secret", "/sink"]);
    expect(small.checks).toBe(2);
    expect(large.checks).toBe(2);
  });

  test("a templated state key taints every literal key sharing its prefix", () => {
    const writes: DataWrite[] = [
      { into: "/hit", source: "state", from: "sel_2" },
      { into: "/miss", source: "state", from: "other" },
    ];
    const tainted: string[] = [];
    const checks = propagateDataTaint(tainted, [], writes, { stateTainted: ["sel_{index}"] });
    expect(tainted).toEqual(["/hit"]);
    expect(checks).toBe(2);
  });

  test("state-key work counts against the fail-closed copy-check cap", () => {
    const writes = stateChainWrites(COPIES);
    expect(propagateDataTaint(["/c0"], [], writes, { maxChecks: COPIES * 2 })).toBe(COPIES * 2);
    expect(propagateDataTaint(["/c0"], [], writes, { maxChecks: COPIES * 2 - 1 })).toBeUndefined();
  });

  test("a tainted state key bound directly into a request query is refused", () => {
    expect(prototypeSensitiveSinkErrors(stateSinkSpec({ query: { q: { state: "u" } } }))).toEqual([
      {
        path: "root.children[1].onTap[0].query.q.state",
        message: "Sensitive value cannot be bound into a request",
      },
    ]);
  });

  test("a tainted state placeholder in a request url is refused", () => {
    expect(prototypeSensitiveSinkErrors(stateSinkSpec({ url: "https://example.com/{u}" }))).toEqual(
      [
        {
          path: "root.children[1].onTap[0].url",
          message: "Sensitive value cannot be bound into a request",
        },
      ],
    );
  });

  test("persisting a tainted state key is refused", () => {
    expect(prototypeSensitiveSinkErrors(stateSinkSpec({}, ["state:u"]))).toEqual(PERSISTED);
  });

  test("an untainted state key in a request stays accepted", () => {
    expect(
      prototypeSensitiveSinkErrors(stateSinkSpec({ query: { q: { state: "v" } } }, ["state:v"])),
    ).toEqual([]);
  });
});
