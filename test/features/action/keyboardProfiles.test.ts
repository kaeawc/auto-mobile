import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  KEYBOARD_PROFILE_CATALOG_ID,
  KEYBOARD_PROFILE_CATALOG_VERSIONS,
  KEYBOARD_PROFILE_IDS,
} from "../../../src/features/action/keyboardProfiles";

test("keyboard profile ids match the Android profile definitions", () => {
  const source = readFileSync(
    new URL(
      "../../../android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/ime/keyboard/profile/KeyboardProfile.kt",
      import.meta.url,
    ),
    "utf8",
  );
  const definitions = source.slice(source.indexOf("object KeyboardProfiles"));
  const ids = [...definitions.matchAll(/\bid = "([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toEqual([...KEYBOARD_PROFILE_IDS]);
});

test("catalog negotiation remains versioned and preserves existing profile ids", () => {
  expect(KEYBOARD_PROFILE_CATALOG_ID).toBe("automobile_behavior_profiles");
  expect(KEYBOARD_PROFILE_CATALOG_VERSIONS).toEqual([1]);
  expect(KEYBOARD_PROFILE_IDS).toEqual(["direct", "gboard", "samsung"]);
});
