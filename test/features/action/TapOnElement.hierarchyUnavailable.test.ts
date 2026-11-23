import { buildObserveResult } from "../../helpers/observeFixture";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import {
  tapHierarchyAvailability,
  TapHierarchyUnavailableError,
  tapHierarchyUnavailableFields,
  tapHierarchyUnavailableReason,
} from "../../../src/features/action/tapHierarchyUnavailable";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ResultFaker } from "../../fakes/ResultFaker";
import type { ViewHierarchyResult } from "../../../src/models";

const recovering: ViewHierarchyResult = {
  hierarchy: {
    error: "Accessibility service returned null hierarchy",
    unavailableReason: "service_recovering",
    transportFailure: true,
  },
};
const usable: ViewHierarchyResult = { hierarchy: { node: {} } };

function setup(initial: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const selector = new FakeElementSelector();
  const command = new TapOnElement(
    { name: "test", platform: "android", deviceId: "test" },
    new FakeAdbClient(),
    { timer, elementSelector: selector },
  );
  const refresh = spyOn(command, "refreshViewHierarchy").mockImplementation(async () => {
    timer.advanceTime(1);
    return recovering;
  });
  const search = (duration = 1500) =>
    command.searchForElement(
      { action: "tap", text: "GOT IT", searchUntil: { duration } },
      buildObserveResult({
        updatedAt: 0,
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: initial,
        screenSize: { width: 400, height: 800 },
      }),
    );
  return { timer, selector, refresh, search };
}

describe("tapOn search with an unavailable hierarchy (#18983)", () => {
  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });
  afterEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("reports hierarchy unavailable, not not-found, when every read was unavailable", async () => {
    const { search } = setup(recovering);
    const result = await search();
    expect(result.selection.element).toBeNull();
    const error = result.hierarchyUnavailableError;
    expect(error).toBeInstanceOf(TapHierarchyUnavailableError);
    expect(error?.unavailableReason).toBe("service_recovering");
    expect(error?.retryable).toBe(true);
    expect(error?.message).toContain("View hierarchy unavailable (service_recovering)");
    expect(error?.message).toContain("text 'GOT IT'");
    expect(error?.message).not.toContain("Element not found");
  });

  test("null reads keep the reason of the last unavailable tree", async () => {
    const { search, refresh, timer } = setup(recovering);
    refresh.mockImplementation(async () => {
      timer.advanceTime(1);
      return null;
    });
    expect((await search()).hierarchyUnavailableError?.unavailableReason).toBe(
      "service_recovering",
    );
  });

  test("a usable read during the search keeps the not-found path", async () => {
    const { search, refresh, timer } = setup(recovering);
    let calls = 0;
    refresh.mockImplementation(async () => {
      timer.advanceTime(1);
      return ++calls === 3 ? usable : recovering;
    });
    const result = await search();
    expect(result.selection.element).toBeNull();
    expect(result.hierarchyUnavailableError).toBeUndefined();
  });

  test("a usable initial tree keeps the not-found path", async () => {
    const { search } = setup(usable);
    expect((await search()).hierarchyUnavailableError).toBeUndefined();
  });

  test("a match after recovery is returned without an unavailable error", async () => {
    const { search, refresh, selector, timer } = setup(recovering);
    const target = ResultFaker.element({ bounds: { left: 0, top: 0, right: 100, bottom: 50 } });
    let calls = 0;
    refresh.mockImplementation(async () => {
      timer.advanceTime(1);
      if (++calls === 2) {
        selector.setNextElement(target);
        return usable;
      }
      return recovering;
    });
    const result = await search();
    expect(result.selection.element).toBe(target);
    expect(result.hierarchyUnavailableError).toBeUndefined();
  });
});

describe("tapHierarchyUnavailableReason", () => {
  test("classifies reads", () => {
    expect(tapHierarchyUnavailableReason(recovering)).toBe("service_recovering");
    expect(tapHierarchyUnavailableReason(usable)).toBeUndefined();
    expect(tapHierarchyUnavailableReason({ hierarchy: {} })).toBeUndefined();
    expect(tapHierarchyUnavailableReason({ hierarchy: { error: "boom" } })).toBe("unknown");
    expect(
      tapHierarchyUnavailableReason({ hierarchy: { error: "lost", transportFailure: true } }),
    ).toBe("connection_lost");
    expect(
      tapHierarchyUnavailableReason({
        hierarchy: { error: "partial", unavailableReason: "incomplete_capture", node: {} },
      }),
    ).toBeUndefined();
  });

  test("availability reports unknown when no read carried a reason", () => {
    const availability = tapHierarchyAvailability({ hierarchy: { error: "boom" } });
    expect(availability.unavailableReason()).toBe("unknown");
    availability.record(usable);
    expect(availability.unavailableReason()).toBeUndefined();
  });

  test("result fields carry retryable and the reason only for the unavailable error", () => {
    expect(
      tapHierarchyUnavailableFields(
        new TapHierarchyUnavailableError("service_recovering", "text 'x'", 0),
      ),
    ).toEqual({ retryable: true, hierarchyUnavailableReason: "service_recovering" });
    expect(tapHierarchyUnavailableFields(new Error("other"))).toEqual({});
  });
});
