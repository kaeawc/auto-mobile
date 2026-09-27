import { expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { InstalledImeKeySession } from "../../src/features/action/InstalledImeKeySession";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

test("registered keyboard tapImeKey forwards a pre-dispatch abort without IME switch or tap", async () => {
  const mutations: string[] = [];
  const originalRegister = ToolRegistry.registerDeviceAware.bind(ToolRegistry);
  let keyboardHandler: Parameters<typeof ToolRegistry.registerDeviceAware>[3] | undefined;
  const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation((...args) => {
    if (args[0] === "keyboard") {
      keyboardHandler = args[3];
    }
    return originalRegister(...args);
  });
  const tapKey = spyOn(InstalledImeKeySession.prototype, "tapKey").mockImplementation(
    async (_imeId, _key, signal) => {
      signal?.throwIfAborted();
      mutations.push("switch-or-tap");
      throw new Error("Unexpected dispatch");
    },
  );
  try {
    ToolRegistry.clearTools();
    registerInteractionTools();
    expect(keyboardHandler).toBeDefined();
    const controller = new AbortController();
    controller.abort();
    const device = { deviceId: "fake-keyboard", platform: "android" } as BootedDevice;
    await expect(
      keyboardHandler!(
        device,
        { action: "tapImeKey", imeId: "com.example/.Ime", key: "a" },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mutations).toEqual([]);
  } finally {
    registration.mockRestore();
    tapKey.mockRestore();
    ToolRegistry.clearTools();
  }
});
