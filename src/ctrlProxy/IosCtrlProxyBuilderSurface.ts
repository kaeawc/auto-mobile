import type { IosCtrlProxyBuilder } from "./IosCtrlProxyBuilder";

/**
 * The builder members `IOSCtrlProxyManager` calls. The manager depends on this slice rather than
 * on the class, which has a private constructor and private state that no test double can satisfy.
 */
export type IosCtrlProxyBuilderSurface = Pick<
  IosCtrlProxyBuilder,
  | "build"
  | "getExpectedAppHash"
  | "getInstalledBundleVersion"
  | "getXctestrunPath"
  | "needsRebuild"
  | "verifyRunnerBinaryBeforeLaunch"
  | "writeRunnerEnvironment"
>;
