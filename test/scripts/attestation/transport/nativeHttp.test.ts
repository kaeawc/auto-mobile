import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TransportHttpClient } from "../../../../scripts/ci/attestation/transport/appAuth";
import { logger } from "../../../../src/utils/logger";
import { harness } from "./fakes";

describe("native attestation fetch adapter", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    // Every native-adapter test is offline, including assertion-failure paths.
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fetch"));
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  test("passes redirect error to native fetch", async () => {
    fetchSpy.mockResolvedValue(new Response("{}"));
    const { timer } = harness();
    const client = new TransportHttpClient({ timer });
    expect(await client.request("https://example.test", { method: "GET", headers: {} })).toEqual(
      {},
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  test("cancels streaming response immediately beyond 65536 bytes", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls <= 4) {
            controller.enqueue(new Uint8Array(pulls <= 2 ? 32_768 : 1));
          } else {
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    fetchSpy.mockResolvedValue(new Response(stream));
    const { timer } = harness();
    await expect(
      new TransportHttpClient({ timer }).request("https://example.test", {
        method: "GET",
        headers: {},
      }),
    ).rejects.toThrow("invalid-response");
    expect(cancelled).toBe(true);
    expect(pulls).toBe(3);
  });

  test("accepts exactly 65536 streamed bytes with a split UTF-8 character", async () => {
    const text = "é".repeat(32_767);
    const bytes = Buffer.from(JSON.stringify(text));
    expect(bytes.byteLength).toBe(65_536);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 2));
        controller.enqueue(bytes.subarray(2));
        controller.close();
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream));
    const { timer } = harness();
    expect(
      await new TransportHttpClient({ timer }).request("https://example.test", {
        method: "GET",
        headers: {},
      }),
    ).toBe(text);
  });
});
