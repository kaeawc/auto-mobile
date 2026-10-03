interface CtrlProxyRegistry {
  clearInstanceRegistryForTesting(): void;
}

export interface CtrlProxyRegistryCleanupEntry {
  isLoaded(): boolean;
  clear(): void;
}

export interface CtrlProxyRegistryCleanupDependencies {
  entries: readonly CtrlProxyRegistryCleanupEntry[];
}

export function createCtrlProxyRegistryCleanup({
  entries,
}: CtrlProxyRegistryCleanupDependencies): () => void {
  return () => {
    for (const entry of entries) {
      if (entry.isLoaded()) {
        entry.clear();
      }
    }
  };
}

// Resolving paths does not evaluate the clients. Check the current file's cache
// at each cleanup: an unloaded module has no instances to clear.
const androidModulePath =
  require.resolve("../../src/features/observe/android/AndroidCtrlProxyClient");
const iosModulePath = require.resolve("../../src/features/observe/ios/IOSCtrlProxyClient");

// Registry-only cleanup avoids resetInstances()' fire-and-forget adb/socket work
// and preserves PortManager clocks and allocations installed by beforeAll.
export const clearCtrlProxyRegistries = createCtrlProxyRegistryCleanup({
  entries: [
    {
      isLoaded: () => require.cache[androidModulePath] !== undefined,
      clear: () => {
        const clientModule: {
          AndroidCtrlProxyClient: CtrlProxyRegistry;
        } = require("../../src/features/observe/android/AndroidCtrlProxyClient");
        clientModule.AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
      },
    },
    {
      isLoaded: () => require.cache[iosModulePath] !== undefined,
      clear: () => {
        const clientModule: {
          IOSCtrlProxyClient: CtrlProxyRegistry;
        } = require("../../src/features/observe/ios/IOSCtrlProxyClient");
        clientModule.IOSCtrlProxyClient.clearInstanceRegistryForTesting();
      },
    },
  ],
});
