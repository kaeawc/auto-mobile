import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { tcpHostLoopbackProbe } from "../../../src/features/portReverse/HostLoopbackProbe";

/**
 * The real host probe against loopback. A listening server accepts at once and a closed port is
 * refused at once, so neither waits on the connect timeout.
 */
describe("tcpHostLoopbackProbe", () => {
  let server: Server | null = null;

  afterEach(async () => {
    const open = server;
    server = null;
    if (open?.listening) {
      await new Promise<void>((resolve) => open.close(() => resolve()));
    }
  });

  const listen = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const created = createServer();
      server = created;
      created.once("error", reject);
      created.listen(0, host, () => {
        const address = created.address();
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no ephemeral port"));
        }
      });
    });

  test("a port with a 127.0.0.1 listener is listening", async () => {
    const port = await listen("127.0.0.1");
    expect(await tcpHostLoopbackProbe.probe(port)).toBe("listening");
  });

  test("a port nothing listens on is refused", async () => {
    const port = await listen("127.0.0.1");
    const open = server;
    server = null;
    await new Promise<void>((resolve) => open?.close(() => resolve()));
    expect(await tcpHostLoopbackProbe.probe(port)).toBe("refused");
  });
});
