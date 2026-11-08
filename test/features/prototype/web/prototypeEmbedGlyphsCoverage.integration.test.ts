import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypeGlyphKeys } from "../../../../src/features/prototype/web/prototypeEmbedGlyphs";
import type { PrototypeIconGlyphSource } from "../../../../src/features/prototype/web/webIconGlyphs";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const VALID = join(import.meta.dir, "../../../fixtures/prototype-spec/valid");

/** A glyph source that records every `<variant>/<name>` a render asks for and draws none. */
function recordingSource(asked: Set<string>): PrototypeIconGlyphSource {
  return {
    glyph(name, variant) {
      asked.add(`${variant}/${name}`);
      return undefined;
    },
  };
}

describe("prototype embed glyph coverage (#16609)", () => {
  // The envelope's keys are collected statically, so a renderer that starts drawing a glyph no
  // `iconName` slot names (as the chip, segment, select and date picker do) must be added to the
  // collector. Every valid fixture's Android still asks only for keys the envelope ships.
  test("every glyph an Android still draws is a key its embed envelope ships", () => {
    const files = readdirSync(VALID).filter((name) => name.endsWith(".json"));
    const uncovered = files.flatMap((file) => {
      const spec: Record<string, unknown> = JSON.parse(
        readFileSync(join(VALID, file), "utf8").replace(/^﻿/, ""),
      );
      const asked = new Set<string>();
      renderPrototypeStill(spec, { frame: "pixel-9", glyphs: recordingSource(asked) });
      const shipped = new Set(prototypeGlyphKeys(spec));
      return [...asked].filter((key) => !shipped.has(key)).map((key) => `${file}: ${key}`);
    });
    expect(files.length).toBeGreaterThan(0);
    expect(uncovered).toEqual([]);
  });
});
