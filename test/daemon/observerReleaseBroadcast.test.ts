import { useCapturedLogs } from "../helpers/captureLogs";
import { afterEach, expect, test } from "bun:test";
import { ObserverReleaseBroadcaster } from "../../src/daemon/observerReleaseBroadcast";

const logs = useCapturedLogs();

afterEach(() => ObserverReleaseBroadcaster.clearForTesting());

test("fans an observer release out to every subscriber, isolating a throwing one (#11076)", () => {
  logs.clear();
  const seen: string[] = [];
  ObserverReleaseBroadcaster.subscribe(() => {
    throw new Error("broken stream server");
  });
  const unsubscribe = ObserverReleaseBroadcaster.subscribe((id) => seen.push(id));

  ObserverReleaseBroadcaster.emit("observer-a");
  unsubscribe();
  ObserverReleaseBroadcaster.emit("observer-b");
  expect(seen).toEqual(["observer-a"]);
  expect(logs.calls("warn")).toHaveLength(2);
});
