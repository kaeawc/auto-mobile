import { describe, expect, test } from "bun:test";
import {
  renderPlatformModules,
  renderPrototypeGuide,
} from "../../../src/features/prototype/prototypeGuide";
import { PROTOTYPE_PLATFORM_MODULES } from "../../../src/features/prototype/prototypePlatform";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { GUIDE_MEDIA_ACTIONS } from "../../../src/features/prototype/prototypeGuideProseMore";

const guide = renderPrototypeGuide();
const productionModules = Object.entries(PROTOTYPE_PLATFORM_MODULES).filter(
  ([, module]) => module.placeholder !== true,
);

describe("platform guide section", () => {
  test("lists every production module, capability, call, event and state key", () => {
    for (const [name, module] of productionModules) {
      expect(guide).toContain(`| \`${name}\` |`);
      expect(guide).toContain(`\`${module.capability}\``);
      for (const op of Object.keys(module.calls)) {
        expect(guide).toContain(`\`${name}.${op}\``);
      }
      for (const event of Object.keys(module.events)) {
        expect(guide).toContain(`\`${name}.${event}\``);
      }
      for (const key of Object.keys(module.state ?? {})) {
        const scope =
          name === "media"
            ? "players/<id>/"
            : name === "notifications" && key === "blocked"
              ? "channels/<id>/"
              : "";
        expect(guide).toContain(`\`/${name}/${scope}${key}\``);
      }
    }
  });

  test("names media state under its declared player, never as a module-level key", () => {
    expect(guide).toContain("`/media/players/<id>/positionMs`");
    expect(guide).not.toContain("`/media/positionMs`");
  });

  test("names the notification blocked key under its declared channel", () => {
    expect(guide).toContain("`/notifications/channels/<id>/blocked`");
    expect(guide).not.toContain("`/notifications/blocked`");
  });

  test("keeps the test placeholder out of the guide", () => {
    expect(guide).not.toContain("prototype_platform_test_v1");
    expect(guide).not.toContain("`test.echo`");
  });

  test("states what a call needs beyond its arguments", () => {
    const table = renderPlatformModules({
      camera: {
        capability: "prototype_platform_camera_v1",
        calls: {
          capture: {
            args: { lens: { optional: true, value: { kind: "enum", values: ["front", "back"] } } },
            permissions: ["camera"],
            background: ["audio"],
            sensitive: true,
          },
        },
        events: {},
      },
    });
    expect(table).toContain(
      "`camera.capture`(lens?: front|back) needs permission camera, background audio",
    );
  });

  test("the worked example is a valid spec", () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(
      guide.slice(guide.indexOf("## Platform features")),
    );
    expect(block).not.toBeNull();
    const result = validatePrototypeSpec(block![1]);
    expect(result.success).toBe(true);
  });

  test("the worked example deep-links a notification tap through a handler push", () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(
      guide.slice(guide.indexOf("## Platform features")),
    );
    const spec = JSON.parse(block![1]);
    const opened = spec.platform.on["notifications.opened"];
    expect(opened).toContainEqual({ type: "push", stack: "nav", screen: "episode" });
    expect(JSON.stringify(spec.root)).toContain("notifications.post");
  });
});

describe("media actions guide section", () => {
  const example = /```json\n([\s\S]*?)\n```/.exec(GUIDE_MEDIA_ACTIONS)?.[1] ?? "";

  test("is part of the rendered guide", () => {
    expect(guide).toContain("### Media actions");
  });

  test("names the capabilities the contract gates pick and capture on", () => {
    const camera = PROTOTYPE_PLATFORM_MODULES.camera;
    expect(GUIDE_MEDIA_ACTIONS).toContain(
      `\`${PROTOTYPE_PLATFORM_MODULES.mediaLibrary.capability}\``,
    );
    expect(GUIDE_MEDIA_ACTIONS).toContain(`\`${camera.capability}\``);
    expect(GUIDE_MEDIA_ACTIONS).toContain(`\`${camera.calls.capture.capability}\``);
  });

  test("the example is a valid spec gated on both modules", () => {
    expect(validatePrototypeSpec(example).success).toBe(true);
    expect(prototypeGateCapabilities(JSON.parse(example))).toEqual(
      expect.arrayContaining([
        "prototype_platform_camera_capture_v1",
        "prototype_platform_camera_v1",
        "prototype_platform_mediaLibrary_v1",
      ]),
    );
  });
});
