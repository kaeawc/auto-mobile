import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import type { ForeignCtrlProxyForwardEvidence } from "../models/ForeignCtrlProxyForwardEvidence";
import type { SavedPrototypeRestoreReport } from "../models/SavedPrototypeRestoreReport";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../utils/SystemTimer";

/** Host-mirrored saved prototypes: what a CtrlProxy reinstall would delete, and how to put it back. */
export interface SavedPrototypeService {
  list(deviceId: string): Promise<ReadonlyArray<{ readonly id: string; readonly label: string }>>;
  restore(device: BootedDevice, timer: Timer): Promise<SavedPrototypeRestoreReport>;
}

/**
 * What the CtrlProxy manager needs from the features tier. The ctrlProxy tier owns this
 * interface; `daemon/ctrlProxyManagerHostWiring` installs the real services and `src/index.ts`
 * imports it first (guarded by test/lint/bootAdmissionWiringEntry.test.ts). Unlike boot
 * admission there is no safe ungated default: dropping foreign-forward evidence or the
 * prototype restore would be silent, so an uninstalled host fails loudly. Tests inject the
 * services through test/helpers/ctrlProxyManagerHost.ts.
 */
export interface CtrlProxyManagerHost {
  /** Evidence that an existing CtrlProxy adb forward belongs to another daemon. */
  createForeignForwardEvidence(adbFactory: AdbClientFactory): ForeignCtrlProxyForwardEvidence;
  savedPrototypes(): SavedPrototypeService;
}

let installed: CtrlProxyManagerHost | undefined;

/** Installs the services; returns the previous host so a test can restore it. */
export function installCtrlProxyManagerHost(
  host: CtrlProxyManagerHost | undefined,
): CtrlProxyManagerHost | undefined {
  const previous = installed;
  installed = host;
  return previous;
}

export function ctrlProxyManagerHostInstalled(): boolean {
  return installed !== undefined;
}

function current(): CtrlProxyManagerHost {
  if (!installed) {
    throw new ActionableError(
      "The CtrlProxy manager host is not installed; src/index.ts imports " +
        "daemon/ctrlProxyManagerHostWiring before any device work, and tests must inject it " +
        "through test/helpers/ctrlProxyManagerHost.",
    );
  }
  return installed;
}

/** Resolves the installed host on every call, so modules loaded first still see it. */
export const ctrlProxyManagerHost: CtrlProxyManagerHost = {
  createForeignForwardEvidence: (adbFactory) => current().createForeignForwardEvidence(adbFactory),
  savedPrototypes: () => current().savedPrototypes(),
};
