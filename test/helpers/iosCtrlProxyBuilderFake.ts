import type { IosCtrlProxyBuilderPort } from "../../src/ctrlProxy/IosCtrlProxyBuilderPort";

/** The public, mockable surface of `IosCtrlProxyBuilder` (its constructor is private). */
export type IosCtrlProxyBuilderMembers = Partial<IosCtrlProxyBuilderPort>;

/**
 * Default fake for IosCtrlProxyBuilder.writeRunnerEnvironment: returns a
 * deterministic per-launch xctestrun path (in the source's directory, without a
 * platform token) so the manager's spawn path can run without touching disk.
 */
export async function fakeWriteRunnerEnvironment(
  xctestrunPath: string,
  _env: Record<string, string>,
  deviceId: string,
): Promise<string> {
  const dir = xctestrunPath.includes("/")
    ? xctestrunPath.slice(0, xctestrunPath.lastIndexOf("/"))
    : ".";
  const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_") || "device";
  return `${dir}/automobile-runner-${safeDeviceId}.xctestrun`;
}

/**
 * Typed builder fake. Tests supply only the members the code under test calls;
 * each member is checked against the real signature (typos and wrong shapes fail
 * the typecheck). Calling a member that was not supplied throws.
 */
export function asIosCtrlProxyBuilder(
  members: IosCtrlProxyBuilderMembers,
): IosCtrlProxyBuilderPort {
  const unsupplied = (name: string) => () => {
    throw new Error(`IosCtrlProxyBuilder.${name} was not supplied to the fake builder`);
  };
  return {
    build: unsupplied("build"),
    getExpectedAppHash: unsupplied("getExpectedAppHash"),
    getInstalledBundleVersion: unsupplied("getInstalledBundleVersion"),
    getRunnerBinaryPath: unsupplied("getRunnerBinaryPath"),
    getXctestrunPath: unsupplied("getXctestrunPath"),
    needsRebuild: unsupplied("needsRebuild"),
    verifyRunnerBinaryBeforeLaunch: unsupplied("verifyRunnerBinaryBeforeLaunch"),
    writeRunnerEnvironment: unsupplied("writeRunnerEnvironment"),
    ...members,
  };
}

/**
 * Builder fake for the simulator start path: resolves `xctestrunPath` (null
 * models "not built") with no runner binary, a no-op pre-launch re-verify, and
 * the deterministic per-launch environment path.
 */
export function createStartableBuilder(
  xctestrunPath: string | null,
  overrides: IosCtrlProxyBuilderMembers = {},
): IosCtrlProxyBuilderPort {
  return asIosCtrlProxyBuilder({
    getXctestrunPath: async () => xctestrunPath,
    getRunnerBinaryPath: async () => null,
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: fakeWriteRunnerEnvironment,
    ...overrides,
  });
}

/**
 * Builder fake for flows that adopt an already-running external runner: any
 * attempt to resolve an xctestrun (i.e. to build or launch) fails the test.
 */
export function createReusedRunnerBuilder(): IosCtrlProxyBuilderPort {
  return asIosCtrlProxyBuilder({
    getXctestrunPath: async () => {
      throw new Error("should not build when an external CtrlProxy process is reused");
    },
    getRunnerBinaryPath: async () => null,
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: fakeWriteRunnerEnvironment,
  });
}
