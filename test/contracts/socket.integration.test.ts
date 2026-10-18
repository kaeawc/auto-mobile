import { createServer, connect, type Server, type Socket } from "node:net";
import { FakeSocket } from "../fakes/FakeNetServer";
import { runSocketContract, type ScriptedSocket } from "./SocketContract";

function scriptedFake(): Promise<ScriptedSocket> {
  const socket = new FakeSocket();
  return Promise.resolve({
    socket,
    peerSend: async (text) => socket.simulateData(text),
    peerReceived: async () => socket.getWrittenDataString(),
    peerClosed: async () => {},
  });
}

// The real side is a loopback socket on an ephemeral port (never a fixed or shared path), so it is
// a safe-tier integration test; each scenario opens and closes its own server (#11868).
async function scriptedReal(): Promise<ScriptedSocket> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  const client = connect(address.port, "127.0.0.1");
  client.on("error", () => {});
  const socket = await accepted;
  const peerClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  let received = "";
  client.on("data", (chunk: Buffer) => {
    received += chunk.toString();
  });
  return {
    socket,
    peerSend: (text) => new Promise<void>((resolve) => client.write(text, () => resolve())),
    peerReceived: async (minBytes) => {
      while (received.length < minBytes && !client.destroyed) {
        await new Promise<void>((resolve) => client.once("data", () => resolve()));
      }
      return received;
    },
    peerClosed: () => peerClosed,
    dispose: async () => {
      client.destroy();
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

runSocketContract("FakeSocket", scriptedFake);
runSocketContract("net.Socket (loopback)", scriptedReal);
