import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { TcpHostPortAvailabilityChecker } from "../../../src/utils/ios/IOSHostPortAvailabilityChecker";

/**
 * These tests exercise the real TCP-connect probe against loopback. They avoid
 * timers entirely: a listening server resolves the connect immediately, and a
 * closed port is refused immediately, so both settle well under the unit budget.
 */
describe("TcpHostPortAvailabilityChecker", function () {
  let server: Server | null = null;

  afterEach(async function () {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function listenOnEphemeralPort(): Promise<number> {
    server = createServer();
    return new Promise<number>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to bind ephemeral port"));
        }
      });
    });
  }

  test("reports a bound port as NOT available (connect succeeds)", async function () {
    const port = await listenOnEphemeralPort();
    const checker = new TcpHostPortAvailabilityChecker();
    expect(await checker.isAvailable("127.0.0.1", port)).toBe(false);
  });

  test("reports a closed port as available (connect refused)", async function () {
    // Bind then immediately release, so the port is almost certainly free and refuses.
    const port = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const checker = new TcpHostPortAvailabilityChecker();
    expect(await checker.isAvailable("127.0.0.1", port)).toBe(true);
  });
});
