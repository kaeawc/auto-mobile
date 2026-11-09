import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitIosGoldenSpecs } from "../../scripts/prototype/ios-golden-specs";
import { androidParitySpec, contentOnly } from "../features/prototype/web/webAndroidParityCases";
import { IOS_PARITY_CASES } from "../features/prototype/web/webIosParityCases";

test("emitter writes the viewer specs and crop manifest into the supplied directory", () => {
  const out = mkdtempSync(join(tmpdir(), "ios-golden-specs-"));
  try {
    emitIosGoldenSpecs(out);
    expect(readdirSync(out).sort()).toEqual(
      ["cases.json", ...IOS_PARITY_CASES.map((entry) => `${entry.golden}.json`)].sort(),
    );
    expect(JSON.parse(readFileSync(join(out, "cases.json"), "utf8"))).toEqual({
      width: 1179,
      height: 2556,
      cropTopPx: 0,
      cases: IOS_PARITY_CASES.map((entry) => ({
        golden: entry.golden,
        mode: entry.mode ?? "light",
      })),
    });
    for (const entry of IOS_PARITY_CASES) {
      expect(JSON.parse(readFileSync(join(out, `${entry.golden}.json`), "utf8"))).toEqual(
        contentOnly(androidParitySpec(entry)),
      );
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
