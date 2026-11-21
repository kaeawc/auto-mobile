import { describe, expect, test } from "bun:test";
import { selectDisposableAppTemplate } from "../../../../src/features/prototype/disposableApp/disposableAppTemplates";
import fixture from "../../../fixtures/prototype-spec/valid/platform-requires.json";

const platform = ["prototype_platform_v1", "prototype_platform_test_v1"];
const base = { name: "base", capabilities: [], size: 1 };
const media = { name: "media", capabilities: platform, size: 3 };
const full = { name: "full", capabilities: [...platform, "prototype_glass_v1"], size: 5 };

describe("selectDisposableAppTemplate", () => {
  test("iOS authorization-only specs select the permissions template", () => {
    const spec = {
      requires: {
        platform: ["notifications"],
        permissions: [{ name: "notifications", purpose: "Send updates" }],
      },
      root: { type: "text", text: "{platform:/notifications/authorization}" },
    };
    const permissions = {
      name: "base",
      capabilities: ["prototype_platform_v1", "prototype_platform_permissions_v1"],
      size: 1,
    };
    expect(selectDisposableAppTemplate(spec, [permissions], "ios")).toBe(permissions);
    expect(() => selectDisposableAppTemplate(spec, [permissions], "android")).toThrow(
      "prototype_platform_notifications_v1",
    );
  });

  test("picks the smallest flavor that advertises every required capability", () => {
    expect(selectDisposableAppTemplate(fixture, [full, media, base]).name).toBe("media");
    expect(selectDisposableAppTemplate({ root: { type: "column" } }, [full, base]).name).toBe(
      "base",
    );
  });

  test("object-form capabilities participate in template selection alongside platform modules", () => {
    const spec = {
      ...fixture,
      requires: { ...fixture.requires, capabilities: ["prototype_links_v1"] },
    };
    const links = { name: "links", capabilities: [...platform, "prototype_links_v1"], size: 4 };
    expect(selectDisposableAppTemplate(spec, [base, media, links]).name).toBe("links");
    expect(() => selectDisposableAppTemplate(spec, [media])).toThrow("prototype_links_v1");
  });

  test("refuses with the capabilities no flavor advertises", () => {
    expect(() => selectDisposableAppTemplate(fixture, [base])).toThrow(
      "The spec needs prototype_platform_test_v1, prototype_platform_v1, which no disposable app template advertises (closest: base; available: base).",
    );
    expect(() => selectDisposableAppTemplate(fixture, [])).toThrow(/No disposable app template/);
  });
});
