import { expect, test } from "bun:test";
import { createCtrlProxyRegistryCleanup } from "./ctrlProxyRegistryCleanup";

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])("clears only loaded registries (Android: %s, iOS: %s)", (androidLoaded, iosLoaded) => {
  const cleared: string[] = [];
  const cleanup = createCtrlProxyRegistryCleanup({
    entries: [
      { isLoaded: () => androidLoaded, clear: () => cleared.push("android") },
      { isLoaded: () => iosLoaded, clear: () => cleared.push("ios") },
    ],
  });

  expect(cleared).toEqual([]);
  cleanup();
  expect(cleared).toEqual([...(androidLoaded ? ["android"] : []), ...(iosLoaded ? ["ios"] : [])]);
});

test("rechecks whether a client is loaded on every cleanup", () => {
  let loaded = false;
  let clears = 0;
  const cleanup = createCtrlProxyRegistryCleanup({
    entries: [
      {
        isLoaded: () => loaded,
        clear: () => {
          if (!loaded) {
            throw new Error("An unloaded client must never be required or cleared");
          }
          clears++;
        },
      },
    ],
  });

  cleanup();
  expect(clears).toBe(0);
  loaded = true;
  cleanup();
  expect(clears).toBe(1);
  loaded = false;
  cleanup();
  expect(clears).toBe(1);
});
