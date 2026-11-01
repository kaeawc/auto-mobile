import { describe, expect, test } from "bun:test";
import { UdpTransport } from "werift";

// An ICMP port-unreachable surfaces on the ICE UDP socket as an asynchronous
// `recvmsg ECONNREFUSED` "error" event. werift 0.25 had no listener, so Node
// rethrew it as an uncaught exception and failed the WebRTC suites (#16294).
describe("werift UdpTransport socket errors", () => {
  test("an asynchronous ECONNREFUSED on the socket does not throw and keeps it open", async () => {
    const transport = await UdpTransport.init("udp4");
    try {
      const refused = Object.assign(new Error("recvmsg ECONNREFUSED"), { code: "ECONNREFUSED" });

      expect(() => transport.socket.emit("error", refused)).not.toThrow();
      expect(transport.closed).toBe(false);
    } finally {
      await transport.close();
    }
  });
});
