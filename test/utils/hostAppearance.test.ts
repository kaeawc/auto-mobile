import { describe, expect, test } from "bun:test";
import { detectHostAppearance } from "../../src/utils/hostAppearance";
import { createExecResult } from "../../src/utils/execResult";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import type { HostDefaultsClient } from "../../src/utils/HostDefaultsClient";

function fakeHostDefaults(supported: boolean, value: string | null): HostDefaultsClient {
  return {
    isSupported: () => supported,
    readGlobal: async () => value,
  };
}

describe("detectHostAppearance", () => {
  test("resolves dark when the injected host client reports Dark", async () => {
    expect(await detectHostAppearance(fakeHostDefaults(true, "Dark"))).toBe("dark");
  });

  test("resolves light when the value is unset (null) on a supported host", async () => {
    expect(await detectHostAppearance(fakeHostDefaults(true, null))).toBe("light");
  });

  test("resolves light for any non-dark value", async () => {
    expect(await detectHostAppearance(fakeHostDefaults(true, "Light"))).toBe("light");
  });
});

describe("detectHostAppearance fallback sequence", () => {
  test.each([
    ["color scheme", ["prefer-dark"], "dark", ["gsettings color-scheme"]],
    ["light scheme stops detection", ["default"], "light", ["gsettings color-scheme"]],
    ["GTK theme", ["", "Adwaita-dark"], "dark", ["gsettings color-scheme", "gsettings gtk-theme"]],
    [
      "KDE 5",
      ["", "", "BreezeDark"],
      "dark",
      ["gsettings color-scheme", "gsettings gtk-theme", "kreadconfig5 ColorScheme"],
    ],
    [
      "KDE 6 after missing command",
      [null, null, null, "BreezeDark"],
      "dark",
      [
        "gsettings color-scheme",
        "gsettings gtk-theme",
        "kreadconfig5 ColorScheme",
        "kreadconfig6 ColorScheme",
      ],
    ],
    [
      "empty KDE 5 does not query KDE 6",
      ["", "", ""],
      "light",
      ["gsettings color-scheme", "gsettings gtk-theme", "kreadconfig5 ColorScheme"],
    ],
    [
      "all commands missing",
      [null, null, null, null],
      "light",
      [
        "gsettings color-scheme",
        "gsettings gtk-theme",
        "kreadconfig5 ColorScheme",
        "kreadconfig6 ColorScheme",
      ],
    ],
  ] as const)("preserves %s", async (_name, responses, expected, expectedCalls) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const calls: string[] = [];
    const executor: HostCommandExecutor = {
      executeCommand: async (command, args = [], options) => {
        expect(options).toEqual({ timeoutMs: 2000 });
        const response = responses[calls.length];
        calls.push(`${command} ${args[args.length - 1]}`);
        if (response === null) {
          throw new Error("command unavailable");
        }
        return createExecResult(response ?? "", "");
      },
    };
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(await detectHostAppearance(fakeHostDefaults(false, null), executor)).toBe(expected);
      expect(calls).toEqual(expectedCalls);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  test("unsupported hosts fall back without commands", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(
        await detectHostAppearance(fakeHostDefaults(false, null), {
          executeCommand: async () => {
            throw new Error("unexpected command");
          },
        }),
      ).toBe("light");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
