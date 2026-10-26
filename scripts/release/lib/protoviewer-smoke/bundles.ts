import { readFileSync } from "node:fs";
import path from "node:path";
import { exportPrototypeBundle } from "../../../../src/features/prototype/prototypeBundle";
import type { SmokeBundle } from "./flows";

const FIXTURE_DIR = path.join(import.meta.dir, "../../../../test/fixtures/prototype-spec/valid");

function bundleOf(fixture: string, label: string): SmokeBundle {
  const specBytes = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, fixture)));
  const exported = exportPrototypeBundle({
    specBytes,
    assets: () => undefined,
    fonts: () => undefined,
  });
  if (!exported.ok) {
    throw new Error(`${fixture} does not fit a bundle: ${exported.code}`);
  }
  return { label, bytes: exported.bytes };
}

/** Two asset-free, validated specs: one standing in for the bundled sample, one for an import. */
export function smokeBundles(): { bundled: SmokeBundle; imported: SmokeBundle } {
  return {
    bundled: bundleOf("chat-scroll.json", "smoke-bundled"),
    imported: bundleOf("checks-form.json", "smoke-imported"),
  };
}
