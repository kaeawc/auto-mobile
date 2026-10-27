import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const points = [
  [0, 1],
  [0.35, 1.3],
  [1, 1],
];
const frames = { trigger: { key: "liked" }, durationMs: 600, tracks: { scale: points } };
const node = (keyframes: unknown = frames) => ({ type: "icon", name: "favorite", keyframes });
const spec = (root: unknown = node()) => ({
  id: "keyframes",
  window: { placement: { type: "fullscreen" } },
  state: { liked: false },
  data: { liked: false },
  root,
});
test("keyframes validates and requires its capability", () => {
  expect(validatePrototypeSpec(spec()).success).toBe(true);
  expect(prototypeGateCapabilities(spec())).toContain("prototype_keyframes_v1");
});
test.each([
  ["duration", { ...frames, durationMs: 99 }, "root.keyframes.durationMs"],
  ["duration integer", { ...frames, durationMs: 100.5 }, "root.keyframes.durationMs"],
  ["duration maximum", { ...frames, durationMs: 3001 }, "root.keyframes.durationMs"],
  [
    "rest",
    {
      ...frames,
      tracks: {
        scale: [
          [0, 1],
          [1, 2],
        ],
      },
    },
    "root.keyframes.tracks.scale",
  ],
  ["unknown track", { ...frames, tracks: { width: points } }, "root.keyframes.tracks.width"],
  ["empty tracks", { ...frames, tracks: {} }, "root.keyframes.tracks"],
  ["undeclared key", { ...frames, trigger: { key: "missing" } }, "root.keyframes.trigger.key"],
  [
    "missing data",
    { ...frames, trigger: { data: "/data/missing" } },
    "root.keyframes.trigger.data",
  ],
  ["empty trigger", { ...frames, trigger: {} }, "root.keyframes.trigger.key"],
  [
    "both trigger forms",
    { ...frames, trigger: { key: "liked", data: "/liked" } },
    "root.keyframes.trigger.key",
  ],
  ["repeat", { ...frames, repeat: true }, "root.keyframes.repeat"],
  [
    "curve",
    { ...frames, tracks: { scale: { points, curve: "bad" } } },
    "root.keyframes.tracks.scale.curve",
  ],
  [
    "fraction",
    {
      ...frames,
      tracks: {
        scale: [
          [0, 1],
          [0, 2],
          [1, 1],
        ],
      },
    },
    "root.keyframes.tracks.scale",
  ],
  [
    "first fraction",
    {
      ...frames,
      tracks: {
        scale: [
          [0.1, 1],
          [1, 1],
        ],
      },
    },
    "root.keyframes.tracks.scale",
  ],
  [
    "last fraction",
    {
      ...frames,
      tracks: {
        scale: [
          [0, 1],
          [0.9, 1],
        ],
      },
    },
    "root.keyframes.tracks.scale",
  ],
  [
    "alpha bounds",
    {
      ...frames,
      tracks: {
        alpha: [
          [0, 1],
          [0.5, 2],
          [1, 1],
        ],
      },
    },
    "root.keyframes.tracks.alpha",
  ],
  [
    "scale positive",
    {
      ...frames,
      tracks: {
        scale: [
          [0, 1],
          [0.5, 0],
          [1, 1],
        ],
      },
    },
    "root.keyframes.tracks.scale",
  ],
  ["few points", { ...frames, tracks: { scale: [[0, 1]] } }, "root.keyframes.tracks.scale"],
  [
    "many points",
    { ...frames, tracks: { scale: Array.from({ length: 9 }, (_, i) => [i / 8, 1]) } },
    "root.keyframes.tracks.scale",
  ],
  [
    "finite",
    {
      ...frames,
      tracks: {
        rotation: [
          [0, 0],
          [0.5, Infinity],
          [1, 0],
        ],
      },
    },
    "root.keyframes.tracks.rotation[1][1]",
  ],
] as const)("rejects %s", (_, keyframes, path) => {
  const result = validatePrototypeSpec(spec(node(keyframes)));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.path).toBe(path);
  }
});
test("data triggers and object curves validate", () => {
  expect(
    validatePrototypeSpec(
      spec(
        node({
          ...frames,
          trigger: { data: "/liked" },
          tracks: { scale: { points, curve: "linear" } },
        }),
      ),
    ).success,
  ).toBe(true);
});
test("the seventeenth expanded node fails at keyframes", () => {
  const result = validatePrototypeSpec(
    spec({ type: "column", children: Array.from({ length: 17 }, () => node()) }),
  );
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.path).toBe("root.children[16].keyframes");
  }
});

test("fields walker covers component roots and every container without walking payloads", async () => {
  const { prototypeKeyframesFields } =
    await import("../../../src/features/prototype/prototypeKeyframes");
  expect(
    prototypeKeyframesFields({
      root: { type: "stack", screens: { home: { type: "scroll", child: node() } } },
      components: { like: { root: node() } },
      data: { keyframes: frames },
    }),
  ).toEqual(['root.screens["home"].child.keyframes', "components.like.root.keyframes"]);
});

test("component instances consume the expanded keyframe budget", () => {
  const instance = { type: "use", component: "like" };
  const authored = {
    ...spec({ type: "column", children: Array.from({ length: 16 }, () => instance) }),
    components: { like: { root: node() } },
  };
  expect(validatePrototypeSpec(authored).success).toBe(true);
  const result = validatePrototypeSpec({
    ...authored,
    root: { type: "column", children: Array.from({ length: 17 }, () => instance) },
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.path).toBe("root.children[16] (use like) → components.like.root.keyframes");
    expect(result.error.message).toBe("Keyframe node limit exceeded");
  }
});
