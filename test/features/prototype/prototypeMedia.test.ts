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
