import type { IosCtrlProxyBuilderSurface } from "../../src/ctrlProxy/IosCtrlProxyBuilderSurface";

/** The members of `IosCtrlProxyBuilder` that `IOSCtrlProxyManager` depends on. */
export type IosCtrlProxyBuilderMembers = Partial<IosCtrlProxyBuilderSurface>;

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

function unsupported(member: string): never {
  throw new Error(`IosCtrlProxyBuilder.${member} was not supplied to the fake builder`);
}

/**
 * Typed `IosCtrlProxyBuilderSurface`. Tests supply only the members the code under test calls;
 * each member is checked against the real signature (typos and wrong shapes fail the typecheck).
 * Calling a member that was not supplied throws, like any missing method.
 */
export function fakeIosCtrlProxyBuilder(
  members: IosCtrlProxyBuilderMembers,
): IosCtrlProxyBuilderSurface {
  return {
    build: members.build ?? (async () => unsupported("build")),
    getExpectedAppHash: members.getExpectedAppHash ?? (() => unsupported("getExpectedAppHash")),
    getInstalledBundleVersion:
      members.getInstalledBundleVersion ?? (async () => unsupported("getInstalledBundleVersion")),
    getXctestrunPath: members.getXctestrunPath ?? (async () => unsupported("getXctestrunPath")),
    needsRebuild: members.needsRebuild ?? (async () => unsupported("needsRebuild")),
    verifyRunnerBinaryBeforeLaunch:
      members.verifyRunnerBinaryBeforeLaunch ??
      (async () => unsupported("verifyRunnerBinaryBeforeLaunch")),
    writeRunnerEnvironment:
      members.writeRunnerEnvironment ?? (async () => unsupported("writeRunnerEnvironment")),
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
): IosCtrlProxyBuilderSurface {
  return fakeIosCtrlProxyBuilder({
    getXctestrunPath: async () => xctestrunPath,
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: fakeWriteRunnerEnvironment,
    ...overrides,
  });
}

/**
 * Builder fake for flows that adopt an already-running external runner: any
 * attempt to resolve an xctestrun (i.e. to build or launch) fails the test.
 */
export function createReusedRunnerBuilder(): IosCtrlProxyBuilderSurface {
  return fakeIosCtrlProxyBuilder({
    getXctestrunPath: async () => {
      throw new Error("should not build when an external CtrlProxy process is reused");
    },
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: fakeWriteRunnerEnvironment,
  });
}
