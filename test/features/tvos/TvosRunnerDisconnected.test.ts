import { describe, expect, test } from "bun:test";
import { WebSocketTvosRunnerClient } from "../../../src/features/tvos/TvosRunnerClient";
import { TvosRunnerDisconnectedError } from "../../../src/features/tvos/TvosRunnerDisconnectedError";
import { TvosRunnerTimeoutError } from "../../../src/features/tvos/TvosRunnerTimeoutError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import connected from "../../fixtures/tvos-xcuitest/tvos-runner-connected.json";

// Once the tvOS runner is disconnected, each later command reports its own outcome: it was not
// sent, and startDevice restarts the runner. It never repeats an earlier command's timeout (#17384).

function fixture() {
  const socket = new FakeWatchSocket();
  const timer = new FakeTimer();
  const client = new WebSocketTvosRunnerClient("ws://fake/ws", { factory: () => socket, timer });
  socket.receive(connected);
  return { socket, timer, client };
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("tvOS runner commands after a disconnect", () => {
  test("a command after a hierarchy timeout names itself, not the earlier timeout", async () => {
    const { socket, timer, client } = fixture();
    const stuck = settle(client.hierarchy());
    await drainMicrotasks(2);
    timer.advanceTime(5000);
    expect(await stuck).toBeInstanceOf(TvosRunnerTimeoutError);

    const press = await settle(client.request({ type: "request_press_button", action: "down" }));
    expect(press).toBeInstanceOf(TvosRunnerDisconnectedError);
    const message = String(press);
    expect(message).toContain("request_press_button");
    expect(message).toContain("already disconnected");
    expect(message).toContain("Call startDevice to restart the runner");
    expect(message).not.toContain("did not answer request_hierarchy");
    expect(socket.sent).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("each later command names itself", async () => {
    const { socket, client } = fixture();
    socket.disconnect();
    const text = await settle(client.request({ type: "request_append_text", text: "hi" }));
    const shot = await settle(client.request({ type: "request_screenshot" }));
    expect(String(text)).toContain("request_append_text");
    expect(String(shot)).toContain("request_screenshot");
    expect(String(shot)).not.toContain("request_append_text");
    expect(socket.sent).toHaveLength(0);
  });

  test("a command in flight when the runner disconnects keeps the disconnect cause", async () => {
    const { socket, client } = fixture();
    const inFlight = settle(client.hierarchy());
    await drainMicrotasks(2);
    socket.disconnect();
    const error = await inFlight;
    expect(error).not.toBeInstanceOf(TvosRunnerDisconnectedError);
    expect(String(error)).toContain("disconnected");
  });

  test("a failure before the handshake still reports its own cause for startup retries", async () => {
    const socket = new FakeWatchSocket();
    const client = new WebSocketTvosRunnerClient("ws://fake/ws", {
      factory: () => socket,
      timer: new FakeTimer(),
    });
    socket.disconnect();
    const error = await settle(client.hierarchy());
    expect(error).not.toBeInstanceOf(TvosRunnerDisconnectedError);
    expect(String(error)).toContain("Tvos runner connection failed");
  });
});
