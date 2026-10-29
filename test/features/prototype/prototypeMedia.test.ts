import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeMediaCallError,
  prototypeMediaPlayers,
  prototypeMediaReadValid,
} from "../../../src/features/prototype/prototypeMedia";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const players = { main: { kind: "video", source: { sample: "colorBars" } } };

function spec(extra: Record<string, unknown>, root: Record<string, unknown>) {
  return {
    id: "media",
    window: { placement: { type: "fullscreen" } },
    requires: { platform: ["media"] },
    media: { players },
    ...extra,
    root,
  };
}

const play = (player: unknown) => ({
  type: "button",
  label: "Play",
  onTap: [{ type: "platform", call: "media.play", args: { player } }],
});

describe("media players", () => {
  test("collects declared player ids, or none without a media block", () => {
    expect([...prototypeMediaPlayers({ media: { players } })]).toEqual(["main"]);
    expect(prototypeMediaPlayers({}).size).toBe(0);
  });

  test("a state-bound player is resolved at runtime, so only literals are checked", () => {
    const result = validatePrototypeSpec(
      spec({ state: { which: "main" } }, play({ state: "which" })),
    );
    expect(result.success).toBe(true);
  });

  test("a literal player that is not declared is refused at its value", () => {
    expect(
      prototypeMediaCallError(
        { call: "media.play", args: { player: { value: "other" } } },
        "root.onTap[0]",
        new Set(["main"]),
      ),
    ).toEqual({ path: "root.onTap[0].args.player.value", message: "Unknown media player" });
    expect(
      prototypeMediaCallError(
        { call: "share.open", args: { player: { value: "other" } } },
        "root",
        new Set(),
      ),
    ).toBeUndefined();
  });

  test("reads take exactly /media/players/<declared id>/<state key>", () => {
    const state = { playing: {}, positionMs: {} };
    const declared = new Set(["main"]);
    expect(prototypeMediaReadValid(["media", "players", "main", "playing"], declared, state)).toBe(
      true,
    );
    expect(prototypeMediaReadValid(["media", "players", "main"], declared, state)).toBe(false);
    expect(prototypeMediaReadValid(["media", "player", "main", "playing"], declared, state)).toBe(
      false,
    );
    expect(
      prototypeMediaReadValid(["media", "players", "main", "playing", "x"], declared, state),
    ).toBe(false);
    // An inherited key is not a state key.
    expect(prototypeMediaReadValid(["media", "players", "main", "toString"], declared, state)).toBe(
      false,
    );
  });

  test("a declared player with a matching read validates", () => {
    const result = validatePrototypeSpec(
      spec({}, { type: "text", text: "{platform:/media/players/main/status}" }),
    );
    expect(result.success).toBe(true);
  });

  test("the media block alone requires the media module capability", () => {
    const required = requiredPrototypeCapabilities(spec({}, { type: "text", text: "Hi" }));
    expect(required).toContain("prototype_platform_media_v1");
  });
});

test("a player declared as __proto__ survives validation with its own key", () => {
  const authored = JSON.parse(
    `{"id":"m","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["media"]},` +
      `"media":{"players":{"__proto__":{"kind":"audio","source":{"sample":"silence"}}}},` +
      `"root":{"type":"text","text":"{platform:/media/players/__proto__/status}"}}`,
  );
  const result = validatePrototypeSpec(authored);
  expect(result.success).toBe(true);
  const players = result.success ? result.data.media?.players : undefined;
  expect(Object.hasOwn(players ?? {}, "__proto__")).toBe(true);
});

describe("videoPlayer nodes", () => {
  const inline = { type: "videoPlayer", id: "clip", source: { sample: "countdown" } };

  test("an inline player's id joins the ids calls and reads may name", () => {
    const root = { media: { players }, root: { type: "column", children: [inline] } };
    expect([...prototypeMediaPlayers(root)].sort()).toEqual(["clip", "main"]);
  });

  test("a node-scoped player can be driven and read like a declared one", () => {
    const result = validatePrototypeSpec(
      spec(
        {},
        {
          type: "column",
          children: [
            inline,
            { type: "text", text: "{platform:/media/players/clip/playing}" },
            play({ value: "clip" }),
          ],
        },
      ),
    );
    expect(result.success).toBe(true);
  });

  test("a declared player is rendered by name without an id", () => {
    const result = validatePrototypeSpec(spec({}, { type: "videoPlayer", player: "main" }));
    expect(result.success).toBe(true);
  });

  test("an inline id must be a state key", () => {
    const result = validatePrototypeSpec(
      spec({}, { type: "videoPlayer", id: "clip-1", source: { sample: "silence" } }),
    );
    expect(result).toEqual({
      success: false,
      error: { path: "root", message: "An inline videoPlayer needs an id that is a state key" },
    });
  });

  test("a positionKey must hold a number in declared state", () => {
    const node = { type: "videoPlayer", player: "main", positionKey: "scrub" };
    expect(validatePrototypeSpec(spec({ state: { scrub: 0 } }, node)).success).toBe(true);
    expect(validatePrototypeSpec(spec({ state: { scrub: true } }, node)).success).toBe(false);
    expect(validatePrototypeSpec(spec({}, node)).success).toBe(false);
  });
});
