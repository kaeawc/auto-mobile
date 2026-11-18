import { describe, expect, test } from "bun:test";
import { selectDisposableAppTemplate } from "../../../../../src/features/prototype/disposableApp/disposableAppTemplates";
import type { PrototypeJson } from "../../../../../src/features/prototype/prototypeJson";
import packaged from "../../../../../android/prototype-app-shell/src/base/assets/capabilities.json";

// The sidecar the `base` flavor packages beside its APK (#14184); the app-shell's
// AppShellCapabilitiesTest keeps it equal to what the shell's renderer and modules provide.
const base = { name: packaged.template, capabilities: packaged.capabilities, size: 1 };

function spec(extra: Record<string, unknown>): PrototypeJson {
  return {
    id: "shell",
    window: { placement: { type: "fullscreen" } },
    root: { type: "text", text: "Hi" },
    ...extra,
  } as PrototypeJson;
}

describe("packaged Android disposable-app template capabilities", () => {
  test("accepts specs that need the shell's platform modules and storage", () => {
    const needsModules = spec({
      requires: { platform: ["location", "biometric", "permissions", "secureStorage"] },
      state: { count: 0 },
      storage: { version: 1, keys: ["state:count"] },
    });
    expect(selectDisposableAppTemplate(needsModules, [base]).name).toBe("base");
  });

  test("accepts renderer features such as a stack", () => {
    const stack = spec({
      root: {
        type: "stack",
        id: "nav",
        start: "home",
        screens: { home: { type: "text", text: "Home" } },
      },
    });
    expect(selectDisposableAppTemplate(stack, [base]).name).toBe("base");
  });

  test("refuses network requests, which the shell wires no transport for", () => {
    const request = spec({
      data: { feed: {} },
      root: {
        type: "button",
        label: "Load",
        onTap: [{ type: "request", url: "https://example.com/feed", into: "/data/feed" }],
      },
    });
    expect(() => selectDisposableAppTemplate(request, [base])).toThrow(/prototype_network_v1/);
  });

  test("refuses a module the shell does not register", () => {
    expect(() =>
      selectDisposableAppTemplate(spec({ requires: { platform: ["notifications"] } }), [base]),
    ).toThrow(/prototype_platform_notifications_v1/);
  });
});
