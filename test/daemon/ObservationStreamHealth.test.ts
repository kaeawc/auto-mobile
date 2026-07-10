import { describe, expect, test } from "bun:test";
import { DefaultObservationStreamHealth } from "../../src/daemon/ObservationStreamHealth";

describe("DefaultObservationStreamHealth", () => {
  test("is healthy only when the stream server is listening at its active socket path", () => {
    const server = {
      listening: true,
      activeSocketPath: true,
      isListening() {
        return this.listening;
      },
      hasActiveSocketPath() {
        return this.activeSocketPath;
      },
    };
    const health = new DefaultObservationStreamHealth({
      getServer: () => server,
      stopServer: async () => {},
      startServer: async () => {},
      configureCallbacks: () => {},
    });

    expect(health.isHealthy()).toBe(true);

    server.activeSocketPath = false;
    expect(health.isHealthy()).toBe(false);

    server.activeSocketPath = true;
    server.listening = false;
    expect(health.isHealthy()).toBe(false);
  });

  test("is unhealthy when no stream server is available", () => {
    const health = new DefaultObservationStreamHealth({
      getServer: () => null,
      stopServer: async () => {},
      startServer: async () => {},
      configureCallbacks: () => {},
    });

    expect(health.isHealthy()).toBe(false);
  });

  test("recovers by stopping, starting, then restoring callbacks", async () => {
    const calls: string[] = [];
    const health = new DefaultObservationStreamHealth({
      getServer: () => null,
      stopServer: async () => {
        calls.push("stop");
      },
      startServer: async () => {
        calls.push("start");
      },
      configureCallbacks: () => {
        calls.push("configure");
      },
    });

    await health.recover();

    expect(calls).toEqual(["stop", "start", "configure"]);
  });
});
