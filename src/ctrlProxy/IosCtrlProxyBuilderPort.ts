import type { IosCtrlProxyBuilder } from "./IosCtrlProxyBuilder";

/**
 * The builder surface the CtrlProxy managers drive. Managers take this slice, not the
 * class (whose constructor is private), so tests can supply a typed fake.
 */
export type IosCtrlProxyBuilderPort = Pick<
  IosCtrlProxyBuilder,
  | "build"
  | "getExpectedAppHash"
  | "getInstalledBundleVersion"
  | "getRunnerBinaryPath"
  | "getXctestrunPath"
  | "needsRebuild"
  | "verifyRunnerBinaryBeforeLaunch"
  | "writeRunnerEnvironment"
>;
