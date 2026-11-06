import { beforeAll, describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

/** Budgets from docs/design-docs/prototype-web-library.md for the core entry. */
// The badge/progress/fab/flow/list/chart/adaptive/swipe component set accounts for the growth past
// 120 KB / 40 KB. Raised for the inlined image renderer (#16533): measured 137,146 bytes plus ~8% headroom.
// The iOS skin's textField, bottomNav, tabBar and sheet account for the gzip growth past 46 KB.
// The watch, TV and car frames and the TV focus ring (#16446) account for the growth past 48 KB.
// The watch/TV/car frames (#16638) and the status bar top-colour walk (#16630) grew it past 148 KB.
// Foldable frames, posture and the hinge drawing (#16632) measured 154,181 / 50,088 bytes.
const MAX_MINIFIED_BYTES = 155_000;
const MAX_GZIP_BYTES = 50_500;

/** Server-only modules the renderer once reached; any of them back in the closure is a regression. */
const FORBIDDEN_INPUTS = [
  "schemas/prototype-spec-contract.json",
  "node_modules/zod/",
  "src/utils/logger.ts",
  "src/config/",
  "src/models/ActionableError.ts",
  "src/models/describeUnknownError.ts",
];

const entry = fileURLToPath(
  new URL("../../../fixtures/prototype-web-bundle/stillEntry.ts", import.meta.url),
);
const builtins = new Set(builtinModules);

interface Bundle {
  code: string;
  builtins: string[];
  inputs: string[];
}

async function bundleStill(): Promise<Bundle> {
  const reached = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: true,
    metafile: true,
    plugins: [
      {
        name: "record-node-builtins",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const name = args.path.replace(/^node:/, "");
            if (args.path.startsWith("node:") || builtins.has(name.split("/")[0] ?? name)) {
              reached.add(`${args.path} (from ${args.importer})`);
              return { path: args.path, external: true };
            }
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "still renderer browser build failed");
  }
  return {
    code: await result.outputs[0].text(),
    builtins: [...reached],
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  };
}

describe("still renderer browser bundle (#16451)", () => {
  let bundle: Bundle;
  beforeAll(async () => {
    bundle = await bundleStill();
  });

  test("reaches no Node builtin", () => {
    expect(bundle.builtins).toEqual([]);
  });

  test("leaves the contract JSON, zod and the server logger out", () => {
    expect(bundle.inputs.length).toBeGreaterThan(0);
    expect(
      bundle.inputs.filter((input) => FORBIDDEN_INPUTS.some((part) => input.includes(part))),
    ).toEqual([]);
  });

  test("tree-shakes the server-only Android wire tables (#16804)", () => {
    const wireTypes = ["request_hierarchy_if_stale", "hierarchy_update"];
    expect(wireTypes.filter((type) => bundle.code.includes(`"${type}"`))).toEqual([]);
  });

  test("stays within the minified and gzip budgets", () => {
    const minified = new TextEncoder().encode(bundle.code).byteLength;
    const gzip = Bun.gzipSync(bundle.code).byteLength;
    expect(minified).toBeLessThanOrEqual(MAX_MINIFIED_BYTES);
    expect(gzip).toBeLessThanOrEqual(MAX_GZIP_BYTES);
  });
});
