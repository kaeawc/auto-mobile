import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { NetworkState, setDefaultResourceNotifier } from "../../src/utils/NetworkState";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

const NOTIFICATION = {
  id: 1,
  timestamp: 1000,
  method: "GET",
  url: "https://api.example.com/data",
  host: "api.example.com",
  path: "/data",
  statusCode: 200,
  durationMs: 100,
  contentType: "application/json",
  error: null,
};

function captureOneRequest(state: NetworkState, timer: FakeTimer): void {
  state.setCapture(true);
  state.onNetworkEvent(NOTIFICATION);
  timer.advanceTime(200);
  state.dispose();
}

describe("NetworkState default notifier", () => {
  // The server registers its notifier once at module load; later tests in this process need it.
  const registered = setDefaultResourceNotifier(undefined);
  setDefaultResourceNotifier(registered);
  afterEach(() => {
    setDefaultResourceNotifier(registered);
  });

  it("is wired to the server ResourceRegistry when that module is loaded", () => {
    // Registration runs when resourceRegistry loads, before any afterEach clears it, so this
    // first test observes the wired default.
    const notify = spyOn(ResourceRegistry, "notifyResourceUpdated").mockResolvedValue();
    const timer = new FakeTimer();
    captureOneRequest(new NetworkState({ timer }), timer);
    expect(notify).toHaveBeenCalledWith("automobile:network/traffic/live");
    expect(notify).toHaveBeenCalledWith("automobile:network/stats");
    notify.mockRestore();
  });

  it("drops updates with a debug log when no notifier is registered", () => {
    setDefaultResourceNotifier(undefined);
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const timer = new FakeTimer();
    captureOneRequest(new NetworkState({ timer }), timer);
    expect(
      debug.mock.calls.some(([message]) => String(message).includes("No resource notifier")),
    ).toBe(true);
    debug.mockRestore();
  });

  it("notifies through a notifier registered after the state was constructed", () => {
    const timer = new FakeTimer();
    const state = new NetworkState({ timer });
    const uris: string[] = [];
    setDefaultResourceNotifier({ notifyResourceUpdated: (uri) => void uris.push(uri) });
    captureOneRequest(state, timer);
    expect(uris).toContain("automobile:network/stats");
  });
});
