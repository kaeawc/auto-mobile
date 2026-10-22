import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { FakeObserverSessionRegistry } from "../fakes/FakeObserverSessionRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { runObserverSessionStoreContract } from "./ObserverSessionStoreContract";

const HEARTBEAT_TIMEOUT_MS = 10_000;

runObserverSessionStoreContract("FakeObserverSessionRegistry", async () => {
  const timer = new FakeTimer();
  return {
    store: new FakeObserverSessionRegistry({ timer, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS }),
    timer,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
});

runObserverSessionStoreContract("ObserverSessionRegistry", async () => {
  const timer = new FakeTimer();
  return {
    store: new ObserverSessionRegistry(timer, HEARTBEAT_TIMEOUT_MS),
    timer,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
});
