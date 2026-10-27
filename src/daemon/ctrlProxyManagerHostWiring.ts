import { installCtrlProxyManagerHost } from "../ctrlProxy/ctrlProxyManagerHost";
import { createForeignCtrlProxyForwardEvidence } from "../features/observe/android/foreignCtrlProxyForwardEvidence";
import { defaultSavedPrototypeMirror } from "../features/prototype/savedPrototypeMirror";
import {
  AndroidSavedPrototypeRestoreDevice,
  restoreSavedPrototypes,
} from "../features/prototype/savedPrototypeRestore";

/**
 * Composition root for the CtrlProxy manager: installs the real foreign-forward evidence and
 * saved-prototype services behind the interface the ctrlProxy tier owns. `src/index.ts` imports
 * it before anything that can drive a device.
 */
installCtrlProxyManagerHost({
  createForeignForwardEvidence: (adbFactory) => createForeignCtrlProxyForwardEvidence(adbFactory),
  savedPrototypes: () => {
    const mirror = defaultSavedPrototypeMirror();
    return {
      list: (deviceId) => mirror.list(deviceId),
      restore: (device, timer) =>
        restoreSavedPrototypes(
          device.deviceId,
          mirror,
          new AndroidSavedPrototypeRestoreDevice(device, timer),
        ),
    };
  },
});
