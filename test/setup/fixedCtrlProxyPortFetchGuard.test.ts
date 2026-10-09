import { describe, expect, test } from "bun:test";
import {
  installFixedCtrlProxyPortFetchGuard,
  isFixedCtrlProxyPortUrl,
} from "./fixedCtrlProxyPortFetchGuard";

describe("fixed CtrlProxy port fetch guard (#11106)", () => {
  test.each([
    "http://127.0.0.1:8765/sdk-events",
    "http://localhost:8767/health",
    "http://[::1]:8864/x",
  ])("%s is a fixed CtrlProxy port", (url) => {
    expect(isFixedCtrlProxyPortUrl(url)).toBe(true);
    expect(isFixedCtrlProxyPortUrl(new URL(url))).toBe(true);
  });

  test.each([
    "http://127.0.0.1:0/sdk-events",
    "http://127.0.0.1:62676/mcp",
    "http://example.com:8765/",
    "http://127.0.0.1/",
    "not a url",
  ])("%s is not", (url) => {
    expect(isFixedCtrlProxyPortUrl(url)).toBe(false);
  });

  test("rejects a unit-test dial without reaching the real fetch, passes others through", async () => {
    const calls: string[] = [];
    const target = {
      fetch: (async (input: unknown) => {
        calls.push(String(input));
        return new Response("ok");
      }) as unknown as typeof fetch,
    };
    installFixedCtrlProxyPortFetchGuard(target, () => "test/x.test.ts");

    await expect(target.fetch("http://127.0.0.1:8765/sdk-events")).rejects.toThrow(
      /must not dial fixed CtrlProxy host ports/,
    );
    expect(await (await target.fetch("http://127.0.0.1:62676/mcp")).text()).toBe("ok");
    expect(calls).toEqual(["http://127.0.0.1:62676/mcp"]);
  });

  test("integration files keep the real fetch", async () => {
    const calls: string[] = [];
    const target = {
      fetch: (async (input: unknown) => {
        calls.push(String(input));
        return new Response("ok");
      }) as unknown as typeof fetch,
    };
    installFixedCtrlProxyPortFetchGuard(target, () => "test/x.integration.test.ts");
    await target.fetch("http://127.0.0.1:8765/health");
    expect(calls).toEqual(["http://127.0.0.1:8765/health"]);
  });
});
