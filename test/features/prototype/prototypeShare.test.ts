import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import rawFixtures from "../../fixtures/prototype-share.json";
import corpus from "../../fixtures/prototype-spec/corpus.json";
import {
  resolvePrototypeShare,
  type PrototypeShareInputs,
  type PrototypeShareResolution,
} from "../../../src/features/prototype/prototypeShare";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { collectPrototypeAssetReferences } from "../../../src/features/prototype/prototypeAssetReferences";

interface ShareFixture {
  name: string;
  args: Record<string, unknown>;
  inputs: Omit<PrototypeShareInputs, "assets"> & {
    assets: Readonly<Record<string, unknown>>;
  };
  expected: PrototypeShareResolution;
}
const fixtures: ShareFixture[] = rawFixtures as ShareFixture[];

describe("shared share resolver expectations", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      // Refusal fixtures deliberately include malformed asset inventory metadata.
      expect(resolvePrototypeShare(fixture.args, fixture.inputs as PrototypeShareInputs)).toEqual(
        fixture.expected,
      );
    });
  }
});
describe("share contract corpus", () => {
  for (const name of corpus.valid.filter((name) => name.startsWith("share-"))) {
    test(name, () => {
      const spec = JSON.parse(
        readFileSync(
          new URL(`../../fixtures/prototype-spec/valid/${name}`, import.meta.url),
          "utf8",
        ),
      );
      expect(validatePrototypeSpec(spec).success).toBe(true);
      expect(prototypeGateCapabilities(spec)).toContain("prototype_platform_share_v1");
    });
  }
  for (const name of corpus.invalid.filter((name) => name.startsWith("share-"))) {
    test(name, () => {
      const fixture = JSON.parse(
        readFileSync(
          new URL(`../../fixtures/prototype-spec/invalid/${name}`, import.meta.url),
          "utf8",
        ),
      );
      expect(
        validatePrototypeSpec(fixture.spec, {
          ...fixture.options,
          requiredCapabilities: prototypeGateCapabilities,
        }),
      ).toEqual({
        success: false,
        error: { path: fixture.expectedPath, message: fixture.expectedMessage },
      });
    });
  }
  test("literal asset slots join bundle inventory references", () => {
    const spec = JSON.parse(
      readFileSync(
        new URL("../../fixtures/prototype-spec/valid/share-full.json", import.meta.url),
        "utf8",
      ),
    );
    expect([...collectPrototypeAssetReferences(spec).images].sort()).toEqual(["file", "image"]);
  });
  test("nested calls and root handlers refuse missing capability", () => {
    const call = { type: "platform", call: "share.open", args: { text: { value: "Hi" } } };
    const base = {
      id: "share",
      window: { placement: { type: "fullscreen" } },
      requires: { platform: ["share", "test"] },
    };
    const roots = [
      {
        type: "button",
        label: "Share",
        onTap: [{ type: "startTimer", id: "timer", delayMs: 100, actions: [call] }],
      },
      {
        type: "button",
        label: "Share",
        onTap: [
          {
            type: "platform",
            call: "test.echo",
            args: { message: { value: "Hi" } },
            onSuccess: [call],
          },
        ],
      },
    ];
    for (const root of roots) {
      expect(prototypeGateCapabilities({ ...base, root })).toContain("prototype_platform_share_v1");
    }
    const handlerSpec = {
      ...base,
      root: { type: "spacer" },
      platform: { on: { "test.tick": [call] } },
    };
    expect(prototypeGateCapabilities(handlerSpec)).toContain("prototype_platform_share_v1");
    expect(
      validatePrototypeSpec(handlerSpec, {
        requiredCapabilities: prototypeGateCapabilities,
        supportedCapabilities: ["prototype_platform_v1", "prototype_platform_test_v1"],
      }),
    ).toEqual({
      success: false,
      error: { path: "$", message: "Unsupported capabilities: prototype_platform_share_v1" },
    });
  });
});

describe("share review regressions", () => {
  const budgetFixture = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/prototype-spec/invalid/share-secure-scan-budget.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  test("library scan refuses repeat byte amplification before expanding strings", () => {
    expect(validatePrototypeSpec(budgetFixture.spec, { library: true })).toEqual({
      success: false,
      error: { path: budgetFixture.expectedPath, message: budgetFixture.expectedMessage },
    });
  });
  const hostSpec = JSON.parse(
    readFileSync(
      new URL("../../fixtures/prototype-spec/valid/share-templated-host.json", import.meta.url),
      "utf8",
    ),
  );
  test("the templated host fixture resolves to a usable URL", () => {
    expect(
      resolvePrototypeShare(hostSpec.root.onTap[0].args, { assets: {}, state: hostSpec.state }),
    ).toMatchObject({
      ok: true,
      payload: { url: "https://example.com/" },
    });
  });
});
