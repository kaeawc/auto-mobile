import { describe, expect, test } from "bun:test";
import {
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
} from "@modelcontextprotocol/server";
import { currentMcpTrace, parseMcpTrace, withMcpTrace } from "../../src/daemon/mcpTraceContext";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;
const meta = { [TRACEPARENT_META_KEY]: traceparent };

describe("MCP trace validation", () => {
  test.each(["00", "01", "02", "ff"])("accepts version 00 flags %s", (flags) => {
    expect(parseMcpTrace({ [TRACEPARENT_META_KEY]: `00-${traceId}-${parentId}-${flags}` })).toEqual(
      {
        traceparent: `00-${traceId}-${parentId}-${flags}`,
        traceId,
        parentId,
        traceFlags: flags,
        tracestate: undefined,
        baggage: undefined,
      },
    );
  });

  test.each(
    [
      undefined,
      null,
      1,
      {},
      [],
      "",
      traceparent.toUpperCase(),
      `01-${traceId}-${parentId}-01`,
      `ff-${traceId}-${parentId}-01`,
      `00-${"0".repeat(32)}-${parentId}-01`,
      `00-${traceId}-${"0".repeat(16)}-01`,
      `00-${traceId.slice(1)}-${parentId}-01`,
      `00-${traceId}-${parentId.slice(1)}-01`,
      `00-${traceId}-${parentId}-1`,
      `00-${traceId}-${parentId}-gg`,
      `00-g${traceId.slice(1)}-${parentId}-01`,
      `${traceparent}-extra`,
      `${traceparent}\n`,
      ` ${traceparent}`,
      "x".repeat(8193),
    ].map((value) => ({ value })),
  )("drops invalid traceparent %#", ({ value }) => {
    expect(
      parseMcpTrace({ [TRACEPARENT_META_KEY]: value, [TRACESTATE_META_KEY]: "vendor=secret" }),
    ).toBeUndefined();
  });

  test.each([null, undefined, [], "meta", 7, true].map((value) => ({ value })))(
    "ignores non-record metadata %#",
    ({ value }) => {
      expect(parseMcpTrace(value)).toBeUndefined();
    },
  );

  test.each([
    "",
    " \t,",
    "vendor=opaque",
    "vendor=two words, \t1tenant@system=state\t",
    `${"a".repeat(256)}=v`,
    `vendor=${"v".repeat(256)}`,
    Array.from({ length: 32 }, (_, i) => `v${i}=x`).join(","),
    `a=${"x".repeat(256)},b=${"x".repeat(251)}`,
  ])("accepts valid tracestate %#", (value) => {
    expect(parseMcpTrace({ ...meta, [TRACESTATE_META_KEY]: value })?.tracestate).toBe(value);
  });

  test.each(
    [
      null,
      [],
      2,
      "missing-equals",
      "vendor=",
      "Vendor=value",
      "1vendor=value",
      "vendor =value",
      "vendor=a=b",
      "vendor=a,vendor=b",
      "tenant@System=x",
      `${"a".repeat(257)}=v`,
      `${"a".repeat(242)}@system=v`,
      `tenant@${"a".repeat(15)}=v`,
      `vendor=${"v".repeat(257)}`,
      "vendor=private\n",
      "vendor=private\r",
      "vendor=priv\tate",
      "vendor=é",
      Array.from({ length: 33 }, (_, i) => `v${i}=x`).join(","),
      `a=${"x".repeat(256)},b=${"x".repeat(252)}`,
    ].map((value) => ({ value })),
  )("drops malformed tracestate without losing parent or baggage %#", ({ value }) => {
    const context = parseMcpTrace({
      ...meta,
      [TRACESTATE_META_KEY]: value,
      [BAGGAGE_META_KEY]: "k=v",
    });
    expect(context?.traceId).toBe(traceId);
    expect(context?.tracestate).toBeUndefined();
    expect(context?.baggage).toBe("k=v");
  });

  test.each([
    "key=value",
    "key=",
    "key=value=with=equals",
    "key=first,key=second",
    " key \t= value ; property ; other = encoded%20value ",
    "key=Am%C3%A9lie;prop=%25",
    "key=!#$&'()*+-./:<=>?@[]^_`{|}~",
    `k=${"v".repeat(8190)}`,
    Array.from({ length: 180 }, (_, i) => `k${i}=v`).join(","),
  ])("accepts valid baggage %#", (value) => {
    expect(parseMcpTrace({ ...meta, [BAGGAGE_META_KEY]: value })?.baggage).toBe(value);
  });

  test.each(
    [
      null,
      {},
      2,
      "",
      "key",
      "=value",
      "bad key=value",
      "key=two words",
      'key="quoted"',
      "key=back\\slash",
      "key=value\n",
      "key=value\r",
      "key=é",
      "key=bad%",
      "key=bad%2g",
      "key=value;",
      "key=value;=invalid",
      "key=value,",
      `k=${"v".repeat(8191)}`,
      Array.from({ length: 181 }, (_, i) => `k${i}=v`).join(","),
    ].map((value) => ({ value })),
  )("drops malformed baggage without losing parent or tracestate %#", ({ value }) => {
    const context = parseMcpTrace({
      ...meta,
      [BAGGAGE_META_KEY]: value,
      [TRACESTATE_META_KEY]: "v=x",
    });
    expect(context?.traceId).toBe(traceId);
    expect(context?.baggage).toBeUndefined();
    expect(context?.tracestate).toBe("v=x");
  });
});

describe("MCP trace async scope", () => {
  test("isolates overlapping requests and async descendants", async () => {
    const first = parseMcpTrace(meta);
    const second = parseMcpTrace({ [TRACEPARENT_META_KEY]: `00-${"1".repeat(32)}-${parentId}-00` });
    const firstReady = Promise.withResolvers<void>();
    const secondReady = Promise.withResolvers<void>();
    const a = withMcpTrace(first, async () => {
      firstReady.resolve();
      await secondReady.promise;
      expect(currentMcpTrace()).toBe(first);
      return Promise.resolve().then(() => currentMcpTrace());
    });
    const b = withMcpTrace(second, async () => {
      await firstReady.promise;
      expect(currentMcpTrace()).toBe(second);
      secondReady.resolve();
      await Promise.resolve();
      expect(currentMcpTrace()).toBe(second);
    });
    expect(currentMcpTrace()).toBeUndefined();
    expect(await a).toBe(first);
    await b;
    expect(currentMcpTrace()).toBeUndefined();
  });

  test("clears nested absent context and restores after return and failure", async () => {
    const ctx = parseMcpTrace(meta);
    await withMcpTrace(ctx, async () => {
      expect(withMcpTrace(undefined, currentMcpTrace)).toBeUndefined();
      expect(() =>
        withMcpTrace(undefined, () => {
          throw new Error("sync");
        }),
      ).toThrow("sync");
      expect(currentMcpTrace()).toBe(ctx);
      await expect(
        withMcpTrace(undefined, async () => {
          throw new Error("async");
        }),
      ).rejects.toThrow("async");
      expect(currentMcpTrace()).toBe(ctx);
    });
    expect(currentMcpTrace()).toBeUndefined();
  });
});
