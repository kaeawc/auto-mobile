import type { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";

/** The public, mockable surface of `IosCtrlProxyBuilder` (its constructor is private). */
export type IosCtrlProxyBuilderMembers = Partial<IosCtrlProxyBuilder>;

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
 * Typed partial `IosCtrlProxyBuilder`. `IosCtrlProxyBuilder` has a private
 * constructor and private state, so no object literal can satisfy it
 * structurally. Tests supply only the members the code under test calls; each
 * member is checked against the real signature (typos and wrong shapes fail the
 * typecheck). Calling a member that was not supplied throws, like any missing
 * method. This is the one place the narrowing assertion lives.
 */
export function asIosCtrlProxyBuilder(members: IosCtrlProxyBuilderMembers): IosCtrlProxyBuilder {
  return members as unknown as IosCtrlProxyBuilder;
}

/**
 * Builder fake for the simulator start path: resolves `xctestrunPath` (null
 * models "not built") with no runner binary, a no-op pre-launch re-verify, and
 * the deterministic per-launch environment path.
 */
export function createStartableBuilder(
  xctestrunPath: string | null,
  overrides: IosCtrlProxyBuilderMembers = {},
): IosCtrlProxyBuilder {
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
export function createReusedRunnerBuilder(): IosCtrlProxyBuilder {
  return asIosCtrlProxyBuilder({
    getXctestrunPath: async () => {
      throw new Error("should not build when an external CtrlProxy process is reused");
    },
    getRunnerBinaryPath: async () => null,
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: fakeWriteRunnerEnvironment,
  });
}
