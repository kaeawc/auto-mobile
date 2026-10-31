export type FixtureIdentity = {
  avdName: string;
  systemImageId: string;
  avdConfigHash: string;
  emulatorVersion: string;
};

export interface FixtureIdentityProbe {
  currentIdentity(avdName: string): Promise<FixtureIdentity>;
}

export type FixtureInvalidationReason =
  | "avd-changed"
  | "system-image-changed"
  | "avd-config-changed"
  | "emulator-version-changed";

export async function checkFixtureValidity(
  recorded: FixtureIdentity,
  probe: FixtureIdentityProbe,
): Promise<{ valid: true } | { valid: false; reasons: FixtureInvalidationReason[] }> {
  const current = await probe.currentIdentity(recorded.avdName);
  const reasons: FixtureInvalidationReason[] = [];

  if (current.avdName !== recorded.avdName) {
    reasons.push("avd-changed");
  }
  if (current.systemImageId !== recorded.systemImageId) {
    reasons.push("system-image-changed");
  }
  if (current.avdConfigHash !== recorded.avdConfigHash) {
    reasons.push("avd-config-changed");
  }
  if (current.emulatorVersion !== recorded.emulatorVersion) {
    reasons.push("emulator-version-changed");
  }

  return reasons.length === 0 ? { valid: true } : { valid: false, reasons };
}
