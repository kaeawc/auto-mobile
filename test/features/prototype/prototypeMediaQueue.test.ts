import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeMediaQueueFields } from "../../../src/features/prototype/prototypeMediaQueue";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const episode = (id: string) => ({ id, title: `Episode ${id}`, source: { sample: "tone440" } });

function spec(player: Record<string, unknown>, episodes: unknown = [episode("a"), episode("b")]) {
  return {
    id: "queue",
    window: { placement: { type: "fullscreen" } },
    data: { show: { episodes } },
    requires: { platform: ["media"] },
    media: { players: { pod: { kind: "audio", ...player } } },
    root: { type: "text", text: "{platform:/media/players/pod/currentItemId}" },
  };
}

describe("media player queues", () => {
  test("a queued player validates and needs the queue capability", () => {
    const queued = spec({ queue: "/data/show/episodes" });
    expect(validatePrototypeSpec(queued).success).toBe(true);
    expect(prototypeMediaQueueFields(queued)).toEqual(["media.players.pod.queue"]);
    expect(requiredPrototypeCapabilities(queued)).toContain("prototype_platform_media_queue_v1");
  });

  test("a single-source player does not need the queue capability", () => {
    const single = spec({ source: { sample: "tone440" } });
    expect(requiredPrototypeCapabilities(single)).not.toContain(
      "prototype_platform_media_queue_v1",
    );
  });

  test("a player needs exactly one of source or queue", () => {
    for (const player of [{}, { queue: "/data/show/episodes", source: { sample: "silence" } }]) {
      expect(validatePrototypeSpec(spec(player))).toEqual({
        success: false,
        error: {
          path: "media.players.pod",
          message: "A media player needs exactly one of source or queue",
        },
      });
    }
  });

  test("the queue must point at a declared /data array", () => {
    for (const queue of ["/data/show", "/data/show/missing"]) {
      expect(validatePrototypeSpec(spec({ queue }))).toEqual({
        success: false,
        error: { path: "media.players.pod.queue", message: "queue must point to a /data array" },
      });
    }
  });

  test("each item is checked against the shared item shape, with unique ids", () => {
    const missing = spec({ queue: "/data/show/episodes" }, [{ id: "a", title: "A" }]);
    expect(validatePrototypeSpec(missing)).toEqual({
      success: false,
      error: { path: "data.show.episodes[0].source", message: "Required property" },
    });
    const duplicate = spec({ queue: "/data/show/episodes" }, [episode("a"), episode("a")]);
    expect(validatePrototypeSpec(duplicate)).toEqual({
      success: false,
      error: { path: "data.show.episodes[1].id", message: "Duplicate queue item id" },
    });
  });
});
