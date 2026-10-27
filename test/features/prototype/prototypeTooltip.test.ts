import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  prototypeTooltipFields,
  prototypeTooltipUnsupportedMessage,
} from "../../../src/features/prototype/prototypeTooltip";
import {
  prototypeAnchorPlacementError,
  resolvePrototypeAnchors,
} from "../../../src/features/prototype/prototypeAnchors";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH,
  prototypeSpecSchema,
} from "../../../src/features/prototype/prototypeSpec";
import { mapBindableFields } from "../../../src/features/prototype/prototypeTemplate";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { capturedFloatingCoverHierarchy } from "../../helpers/prototypeWindowCapture";

const tooltip = {
  type: "tooltip",
  text: "Hint",
  anchorTo: "target",
  openWhen: { key: "open", equals: true },
};
const target = { type: "button", id: "target", label: "Help" };
const spec = (children: object[]) => ({
  id: "tip",
  window: { placement: { type: "fullscreen" } },
  state: { open: true },
  root: { type: "column", children },
});
const directory = new URL("../../fixtures/prototype-spec/invalid/", import.meta.url);
for (const name of readdirSync(directory).filter(
  (name) => name.startsWith("tooltip-") && !name.startsWith("tooltip-drawer-"),
)) {
  const fixture: { spec: unknown; expectedPath: string; expectedMessage: string } = JSON.parse(
    readFileSync(new URL(name, directory), "utf8"),
  );
  test(`shared tooltip rejection: ${name}`, () => {
    expect(validatePrototypeSpec(fixture.spec)).toMatchObject({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}

test("tooltip discovery covers repeat templates and components, ignoring opaque payloads", () => {
  expect(
    prototypeTooltipFields({
      root: {
        type: "column",
        repeat: { as: "item", items: [{}] },
        children: [tooltip],
        payload: tooltip,
      },
      components: { Tip: { root: tooltip } },
    }),
  ).toEqual(["root.children[0]", "components.Tip.root"]);
  expect(prototypeTooltipFields(null)).toEqual([]);
  expect(prototypeGateCapabilities(spec([target, tooltip]))).toContain("prototype_tooltip_v1");
});

test("tooltip refusal identifies capability, path, multiplicity and platform update", () => {
  expect(prototypeTooltipUnsupportedMessage(["root"], "android")).toContain("prototype_tooltip_v1");
  expect(prototypeTooltipUnsupportedMessage(["root", "components.Tip.root"], "ios")).toContain(
    "root (and 1 more)",
  );
  expect(prototypeTooltipUnsupportedMessage(["root"], "ios")).toContain(
    "launchApp prototype: true",
  );
});

test("expanded component ids are counted; unused definitions are not targets", () => {
  const components = { Target: { root: target } };
  const use = { type: "use", component: "Target" };
  expect(validatePrototypeSpec({ ...spec([use, tooltip]), components }).success).toBe(true);
  expect(validatePrototypeSpec({ ...spec([use, use, tooltip]), components })).toMatchObject({
    success: false,
    error: { path: "root.children[2].anchorTo", message: 'Duplicate anchorTo id "target"' },
  });
  expect(validatePrototypeSpec({ ...spec([tooltip]), components })).toMatchObject({
    success: false,
    error: { message: 'Unknown anchorTo id "target"' },
  });
});

test("tooltip text and dismissal action bindings use the existing template visitor", () => {
  const paths: string[] = [];
  mapBindableFields(
    { ...tooltip, text: "{data:/hint}", onDismiss: [{ type: "emit", name: "{item.name}" }] },
    "root",
    (value, path, kind) => {
      if (kind === "text") {
        paths.push(path);
      }
      return value;
    },
  );
  expect(paths).toContain("root.text");
  const result = validatePrototypeSpec({
    ...spec([target, { ...tooltip, text: "{data:/hint}" }]),
    data: { hint: "Help" },
  });
  expect(result.success).toBe(true);
  expect(
    prototypeGateCapabilities({
      ...spec([
        target,
        {
          ...tooltip,
          onDismiss: [{ type: "emit", name: "closed", context: { open: { state: "open" } } }],
        },
      ]),
    }),
  ).toContain("prototype_emit_context_v1");
});

test("tooltip element anchors resolve to target bounds and remain overlay anchors", () => {
  const result = validatePrototypeSpec(
    spec([
      {
        type: "tooltip",
        text: "Hint",
        openWhen: tooltip.openWhen,
        anchor: { type: "element", selector: { elementId: "button_elevated" }, alignment: "cover" },
      },
    ]),
  );
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  const resolved = resolvePrototypeAnchors(result.data, {
    hierarchy: capturedFloatingCoverHierarchy(),
  });
  expect(resolved.anchors[0]?.path).toBe("root.children[0]");
  expect(resolved.spec.root.type === "column" && resolved.spec.root.children[0]?.anchor?.type).toBe(
    "bounds",
  );
  expect(
    prototypeAnchorPlacementError({
      ...resolved.spec,
      window: {
        ...resolved.spec.window,
        placement: { type: "floating", gravity: "center", offset: { x: 0, y: 0 } },
      },
    }),
  ).toBeUndefined();
});

test("tooltip text substitution keeps the shared resolved-text size guard", () => {
  const candidate = {
    ...spec([target, { ...tooltip, text: "{data:/hint}" }]),
    data: { hint: "x".repeat(MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH + 1) },
  };
  expect(validatePrototypeSpec(candidate)).toMatchObject({
    success: false,
    error: { path: "root.children[1].text" },
  });
});

test("Zod enforces exactly one target form and preserves renderer defaults as absent", () => {
  expect(prototypeSpecSchema.safeParse(spec([target, tooltip])).success).toBe(true);
  expect(
    prototypeSpecSchema.safeParse(
      spec([
        { ...tooltip, anchor: { type: "bounds", bounds: { x: 0, y: 0, width: 1, height: 1 } } },
      ]),
    ).success,
  ).toBe(false);
  const result = validatePrototypeSpec(spec([target, tooltip]));
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  expect(result.data.root.type === "column" && result.data.root.children[1]).not.toHaveProperty(
    "caret",
  );
});
