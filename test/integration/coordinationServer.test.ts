import { afterEach, describe, expect, test } from "bun:test";
import { CoordinationServer } from "../../examples/webrtc-coordination-server/coordinationServer";

/** Lightweight tests for the coordination server's registry / error paths. */

let server: CoordinationServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("CoordinationServer", () => {
  test("lists no streams initially and returns null for unknown ids", () => {
    server = new CoordinationServer({ iceServers: [] });
    expect(server.listStreams()).toEqual([]);
    expect(server.getStream("nope")).toBeNull();
  });

  test("subscribing to an unknown stream throws", async () => {
    server = new CoordinationServer({ iceServers: [] });
    await expect(server.subscribe("missing", "v=0")).rejects.toThrow(/No such stream/);
  });

  test("stopIngest / stopSubscriber are safe no-ops for unknown ids", async () => {
    server = new CoordinationServer({ iceServers: [] });
    await expect(server.stopIngest("missing")).resolves.toBeUndefined();
    await expect(server.stopSubscriber("missing", "sub")).resolves.toBeUndefined();
  });
});
