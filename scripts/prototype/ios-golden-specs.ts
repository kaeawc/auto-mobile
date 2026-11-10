import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  androidParitySpec,
  contentOnly,
} from "../../test/features/prototype/web/webAndroidParityCases";
import {
  IOS_PARITY_CASES,
  IOS_PARITY_WIDTH,
  IOS_PARITY_HEIGHT,
  IOS_PARITY_CROP_TOP_PX,
} from "../../test/features/prototype/web/webIosParityCases";

/** The viewer recorder consumes this manifest instead of duplicating geometry or spec edits. */
export function emitIosGoldenSpecs(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const entry of IOS_PARITY_CASES) {
    writeFileSync(
      join(outDir, `${entry.golden}.json`),
      `${JSON.stringify(contentOnly(androidParitySpec(entry)))}\n`,
    );
  }
  writeFileSync(
    join(outDir, "cases.json"),
    `${JSON.stringify({
      width: IOS_PARITY_WIDTH,
      height: IOS_PARITY_HEIGHT,
      cropTopPx: IOS_PARITY_CROP_TOP_PX,
      cases: IOS_PARITY_CASES.map((entry) => ({
        golden: entry.golden,
        mode: entry.mode ?? "light",
      })),
    })}\n`,
  );
}

if (import.meta.main) {
  if (process.argv.length !== 3 || !process.argv[2]) {
    console.error("usage: ios-golden-specs.ts <outdir>");
    process.exitCode = 2;
  } else {
    emitIosGoldenSpecs(process.argv[2]);
  }
}
