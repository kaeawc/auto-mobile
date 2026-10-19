import { describe, expect, test } from "bun:test";
import {
  TapPostTapEffectPhase,
  markObservationFreshAfterSyncRefresh,
  type PostTapEffectHost,
} from "../../../src/features/action/tapPostTapEffectPhase";
import type { ObserveResult, TapOnElementResult, ViewHierarchyResult } from "../../../src/models";

const observation = (overrides: Partial<ObserveResult> = {}): ObserveResult =>
  ({ updatedAt: 1, ...overrides }) as ObserveResult;
const liveHierarchy = (overrides: Partial<ViewHierarchyResult> = {}): ViewHierarchyResult =>
  ({ hierarchy: { node: {} }, updatedAt: 500, ...overrides }) as ViewHierarchyResult;
const staleFreshness = (category: string) =>
  ({ isFresh: false, verified: false, category, warning: "old" }) as never;

describe("markObservationFreshAfterSyncRefresh", () => {
  test("promotes a cache_age verdict when the live hierarchy is complete", () => {
    const obs = observation({
      viewHierarchy: liveHierarchy(),
      freshness: staleFreshness("cache_age"),
    });
    markObservationFreshAfterSyncRefresh(obs);
    expect(obs.freshness).toMatchObject({
      isFresh: true,
      verified: true,
      actualTimestamp: 500,
      ageMs: 0,
    });
    expect(obs.freshness?.warning).toBeUndefined();
    expect(obs.freshness?.category).toBeUndefined();
  });

  test("leaves window_identity failures untouched", () => {
    const freshness = staleFreshness("window_identity");
    const obs = observation({ viewHierarchy: liveHierarchy(), freshness });
    markObservationFreshAfterSyncRefresh(obs);
    expect(obs.freshness).toBe(freshness);
  });

  test("leaves the verdict alone for incomplete or timestampless hierarchies", () => {
    for (const hierarchy of [
      liveHierarchy({ ctrlProxyIncomplete: true }),
      liveHierarchy({ fresh: false }),
      liveHierarchy({ updatedAt: undefined }),
      liveHierarchy({ hierarchy: { error: "x" } as never }),
    ]) {
      const freshness = staleFreshness("cache_age");
      const obs = observation({ viewHierarchy: hierarchy, freshness });
      markObservationFreshAfterSyncRefresh(obs);
      expect(obs.freshness).toBe(freshness);
    }
  });
});

function phase(effect: TapOnElementResult["effect"] | undefined, platform = "android") {
  const host: PostTapEffectHost = {
    applyRefreshedObservationRotation: () => {},
    settlesPostTapChange: () => platform === "android",
    settler: () => {
      throw new Error("settler unused");
    },
    deriveTapEffect: () => effect,
    getScreenSizeFromHierarchy: () => ({ width: 10, height: 20 }),
  };
  return new TapPostTapEffectPhase(host);
}
const changed = { screenChanged: true } as TapOnElementResult["effect"];

describe("TapPostTapEffectPhase.enforceFreshnessConsistency", () => {
  test("retracts freshness when the re-derived effect disagrees", () => {
    const result = { effect: changed, observation: observation() };
    phase({ screenChanged: false } as TapOnElementResult["effect"]).enforceFreshnessConsistency(
      observation(),
      result,
    );
    expect(result.observation.freshness).toMatchObject({
      isFresh: false,
      verified: false,
      category: "effect_inconsistent",
    });
  });

  test("keeps freshness when consistent, asleep, or the effect did not change", () => {
    const consistent = { effect: changed, observation: observation() };
    phase(changed).enforceFreshnessConsistency(observation(), consistent);
    expect(consistent.observation.freshness).toBeUndefined();

    const asleep = { effect: changed, observation: observation({ wakefulness: "Asleep" }) };
    phase(undefined).enforceFreshnessConsistency(observation(), asleep);
    expect(asleep.observation.freshness).toBeUndefined();

    const unchanged = { effect: undefined, observation: observation() };
    phase(undefined).enforceFreshnessConsistency(observation(), unchanged);
    expect(unchanged.observation.freshness).toBeUndefined();
  });
});

describe("TapPostTapEffectPhase.deriveEffectAfterPostTapObservation", () => {
  test("returns the immediate effect on iOS or without a previous observation", async () => {
    const current = observation();
    const ios = await phase(changed, "ios").deriveEffectAfterPostTapObservation(
      observation(),
      current,
    );
    expect(ios).toEqual({ effect: changed, observation: current });
    const none = await phase(changed).deriveEffectAfterPostTapObservation(null, current);
    expect(none.observation).toBe(current);
  });

  test("trusts a non-hierarchy screen change without settling", async () => {
    const effect: TapOnElementResult["effect"] = {
      screenChanged: true,
      basis: "activeWindow changed",
    };
    const current = observation();
    const out = await phase(effect).deriveEffectAfterPostTapObservation(observation(), current);
    expect(out).toEqual({ effect, observation: current });
  });
});

describe("TapPostTapEffectPhase.replaceObservationHierarchy", () => {
  test("swaps the hierarchy, adopts device clock, size, and realigns freshness when refreshed", () => {
    const obs = observation({
      freshness: staleFreshness("cache_age"),
      screenSize: { width: 1, height: 1 },
    });
    phase(undefined).replaceObservationHierarchy(obs, liveHierarchy(), true);
    expect(obs.updatedAt).toBe(500);
    expect(obs.screenSize).toEqual({ width: 10, height: 20 });
    expect(obs.freshness?.isFresh).toBe(true);
  });

  test("delegates the rotation restamp to the platform strategy", () => {
    const stamped: Array<number | undefined> = [];
    const host: PostTapEffectHost = {
      applyRefreshedObservationRotation: (_obs, rotation) => stamped.push(rotation),
      settlesPostTapChange: () => false,
      settler: () => {
        throw new Error("settler unused");
      },
      deriveTapEffect: () => undefined,
      getScreenSizeFromHierarchy: () => undefined,
    };
    new TapPostTapEffectPhase(host).replaceObservationHierarchy(
      observation(),
      liveHierarchy({ rotation: 90 }),
      false,
    );
    expect(stamped).toEqual([90]);
  });

  test("leaves freshness untouched when not refreshed from the device", () => {
    const obs = observation({ freshness: staleFreshness("cache_age") });
    phase(undefined).replaceObservationHierarchy(obs, liveHierarchy(), false);
    expect(obs.freshness?.isFresh).toBe(false);
  });
});
