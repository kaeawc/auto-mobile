import type { PackageSigningInspection } from "../../src/models/PackageSigningInspection";
import type { PackageSigningInspector } from "../../src/features/action/SigningIdentityGuard";

export function signingInspection(
  overrides: Partial<PackageSigningInspection> & { signerSha256?: string[] } = {},
): PackageSigningInspection {
  const { signerSha256, ...rest } = overrides;
  const userId = rest.userId ?? 0;
  return {
    appId: "com.example.app",
    platform: "android",
    deviceId: "emulator-5554",
    userId,
    userSource: "explicit",
    presence: "installed",
    signing: {
      status: "available",
      scheme: "v3",
      signerSha256: signerSha256 ?? [],
      signers: (signerSha256 ?? []).map((sha256) => ({ sha256 })),
    },
    observation: {
      source: "dumpsys-package+apk-signing-block",
      fresh: true,
      observedAt: "2026-10-09T00:00:00.000Z",
      scope: { deviceId: "emulator-5554", userId, appId: "com.example.app" },
      apiLevel: 36,
    },
    ...rest,
  };
}

/** Scripted inspector: each call returns the next entry (the last one repeats) or throws it. */
export class FakePackageSigningInspector implements PackageSigningInspector {
  readonly calls: Array<{ appId: string; userId?: number }> = [];
  private cursor = 0;

  constructor(private readonly script: Array<PackageSigningInspection | Error>) {}

  async execute(appId: string, options?: { userId?: number }): Promise<PackageSigningInspection> {
    this.calls.push({ appId, userId: options?.userId });
    const entry = this.script[Math.min(this.cursor, this.script.length - 1)]!;
    this.cursor += 1;
    if (entry instanceof Error) {
      throw entry;
    }
    return entry;
  }
}
