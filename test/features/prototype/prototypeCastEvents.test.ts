import { describe, expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/cast/events.json";
import {
  PROTOTYPE_CAST_EVENTS,
  PROTOTYPE_CAST_FAILURE_REASONS,
  decodePrototypeCastEvent,
} from "../../../src/features/prototype/prototypeCastEvents";
import {
  PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME,
  PROTOTYPE_PLATFORM_MODULES,
} from "../../../src/features/prototype/prototypePlatform";
import { prototypeCastEventOf } from "../../../src/features/prototype/prototypePlatformEvent";

interface EventCase {
  name: string;
  event: string;
  data: unknown;
  valid: boolean;
}

const cases: EventCase[] = fixture.cases;

const delivered = (payload: Record<string, unknown>) => ({
  kind: "emit" as const,
  name: PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME,
  payload,
});

describe("cast event data (#14239)", () => {
  test("the event and reason lists match the shared fixture and the contract", () => {
    expect<string[]>([...PROTOTYPE_CAST_EVENTS]).toEqual(fixture.events);
    expect<string[]>([...PROTOTYPE_CAST_FAILURE_REASONS]).toEqual(fixture.failureReasons);
    expect(Object.keys(PROTOTYPE_PLATFORM_MODULES.cast!.events)).toEqual(fixture.events);
  });

  for (const eventCase of cases) {
    test(eventCase.name, () => {
      const decoded = decodePrototypeCastEvent(eventCase.event, eventCase.data);
      if (eventCase.valid) {
        expect<unknown>(decoded).toEqual({
          name: eventCase.event.slice("cast.".length),
          data: eventCase.data,
        });
      } else {
        expect(decoded).toBeUndefined();
      }
    });
  }

  test("a delivered platform event decodes to the typed cast event", () => {
    const event = delivered({ event: "cast.remoteVolume", data: { volume: 0.5 } });
    expect(prototypeCastEventOf(event)).toEqual({ name: "remoteVolume", data: { volume: 0.5 } });
  });

  test("truncated data, other emits and other modules are not cast events", () => {
    const data = { player: "mainVideo", reason: "network" };
    expect(
      prototypeCastEventOf(delivered({ event: "cast.sessionFailed", data, truncated: true })),
    ).toBeUndefined();
    expect(
      prototypeCastEventOf({ kind: "emit", name: "tapped", payload: { event: "cast.x", data } }),
    ).toBeUndefined();
    expect(prototypeCastEventOf(delivered({ event: "test.tick", data: {} }))).toBeUndefined();
  });
});
