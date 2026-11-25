import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { TcpEmulatorGrpcPortListenerProbe } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorGrpcPortListenerProbe";

/** Real connect probes against loopback; a listener accepts and a closed port refuses at once. */
describe("TcpEmulatorGrpcPortListenerProbe", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function listen(host?: string): Promise<number> {
    const server = createServer();
    servers.push(server);
    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      // No host binds the wildcard (`::` when the host has IPv6), as the emulator's gRPC server does.
      server.listen({ port: 0, host }, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to bind ephemeral port"));
        }
      });
    });
  }

  test("sees a wildcard listener, which a loopback bind probe misses on macOS", async () => {
    const port = await listen();
    expect(await new TcpEmulatorGrpcPortListenerProbe().isListening(port)).toBe(true);
  });

  test("sees an IPv4 loopback listener", async () => {
    const port = await listen("127.0.0.1");
    expect(await new TcpEmulatorGrpcPortListenerProbe().isListening(port)).toBe(true);
  });

  test("reports a closed port as free", async () => {
    const port = await listen("127.0.0.1");
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    expect(await new TcpEmulatorGrpcPortListenerProbe().isListening(port)).toBe(false);
  });
});
