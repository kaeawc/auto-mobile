import { afterEach, expect, spyOn, test } from "bun:test";
import { ObserverReleaseBroadcaster } from "../../src/daemon/observerReleaseBroadcast";
import { logger } from "../../src/utils/logger";

afterEach(() => ObserverReleaseBroadcaster.clearForTesting());

test("fans an observer release out to every subscriber, isolating a throwing one (#11076)", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const seen: string[] = [];
  ObserverReleaseBroadcaster.subscribe(() => {
    throw new Error("broken stream server");
  });
  const unsubscribe = ObserverReleaseBroadcaster.subscribe((id) => seen.push(id));
  try {
    ObserverReleaseBroadcaster.emit("observer-a");
    unsubscribe();
    ObserverReleaseBroadcaster.emit("observer-b");
    expect(seen).toEqual(["observer-a"]);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});
