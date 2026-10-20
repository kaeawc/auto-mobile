import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { describe, expect, test } from "bun:test";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";

describe("UnixSocketServer session id comes from the injected IdGenerator", () => {
  test("handleConnection keys the session on the injected generator", () => {
    const idGenerator = new CountingIdGenerator("session");
    const server = createHarnessServer(
      "/tmp/never-listened.sock",
      createFakeDaemonState(),
      new FakeTimer(),
      null,
      {},
      idGenerator,
    );

    // handleConnection is only entered after start() enables admission in
    // production. This unit drives the private hook directly, so mirror that
    // lifecycle state before asserting the injected ID sequence.
    server.allowRequests();
    server.connect(new FakeSocket());
    server.connect(new FakeSocket());

    expect(server.sessionIds).toEqual(["session-1", "session-2"]);
  });
});
