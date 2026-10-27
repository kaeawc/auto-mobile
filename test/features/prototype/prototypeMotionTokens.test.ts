import { prototypeMotionTokens } from "../../../src/features/prototype/prototypeMotionTokens";
import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeMotionNodeShape } from "../../../src/features/prototype/prototypeMotionV2Schema";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
const spec = (animate: unknown) => ({
  id: "tokens",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hello", animate },
});
test.each(["fast", "default", "slow"])("tempo %s validates and requires tokens", (tempo) => {
  expect(validatePrototypeSpec(spec({ tempo })).success).toBe(true);
  expect(prototypeGateCapabilities(spec({ tempo }))).toContain("prototype_motion_tokens_v1");
});
test.each([{ durationMs: 300 }, { easing: "spring" }])("tempo rejects conflicting %j", (other) => {
  const animate = { tempo: "fast", ...other };
  expect(validatePrototypeSpec(spec(animate))).toEqual({
    success: false,
    error: {
      path: "root.animate.tempo",
      message: "tempo cannot be combined with durationMs or easing",
    },
  });
  const parsed = prototypeMotionNodeShape.animate.safeParse(animate);
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues[0]).toMatchObject({
      path: ["tempo"],
      message: "tempo cannot be combined with durationMs or easing",
    });
  }
});

test("the runtime table has the specified physical springs", () => {
  const expected = {
    standard: {
      spatial: [
        [0.9, 1400],
        [0.9, 700],
        [0.9, 300],
      ],
    },
    expressive: {
      spatial: [
        [0.6, 800],
        [0.8, 380],
        [0.8, 200],
      ],
    },
  };
  for (const scheme of ["standard", "expressive"] as const) {
    for (const [index, tempo] of (["fast", "default", "slow"] as const).entries()) {
      const [dampingRatio, stiffness] = expected[scheme].spatial[index];
      expect(prototypeMotionTokens[scheme].spatial[tempo]).toEqual({ dampingRatio, stiffness });
      expect(prototypeMotionTokens[scheme].effects[tempo]).toEqual({
        dampingRatio: 1,
        stiffness: [3800, 1600, 800][index],
      });
    }
  }
});
