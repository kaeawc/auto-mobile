import { afterEach, beforeEach } from "bun:test";
import {
  installCtrlProxyManagerHost,
  type CtrlProxyManagerHost,
  type SavedPrototypeService,
} from "../../src/ctrlProxy/ctrlProxyManagerHost";
import type { ForeignCtrlProxyForwardEvidence } from "../../src/models/ForeignCtrlProxyForwardEvidence";

/** Evidence that never finds a foreign forward, so manager tests need no adb forward listing. */
export const noForeignForwardEvidence: ForeignCtrlProxyForwardEvidence = {
  read: async () => ({ kind: "none" }),
};

/** A saved-prototype service with nothing mirrored, so a reinstall restores nothing. */
export const emptySavedPrototypeService: SavedPrototypeService = {
  list: async () => [],
  restore: async () => ({ restored: [], skipped: [], failed: [] }),
};

export function fakeCtrlProxyManagerHost(
  overrides: Partial<CtrlProxyManagerHost> = {},
): CtrlProxyManagerHost {
  return {
    createForeignForwardEvidence: () => noForeignForwardEvidence,
    savedPrototypes: () => emptySavedPrototypeService,
    ...overrides,
  };
}

/**
 * Installs a fake CtrlProxy manager host around every test in the calling describe/file and
 * restores whatever was installed before, so a shared test process never leaks the fake.
 */
export function useFakeCtrlProxyManagerHost(overrides: Partial<CtrlProxyManagerHost> = {}): void {
  let previous: CtrlProxyManagerHost | undefined;
  beforeEach(() => {
    previous = installCtrlProxyManagerHost(fakeCtrlProxyManagerHost(overrides));
  });
  afterEach(() => {
    installCtrlProxyManagerHost(previous);
  });
}
