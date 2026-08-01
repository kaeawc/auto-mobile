import type {
  CodesignVerificationOutcome,
  CtrlProxyCodesignVerifier
} from "../../src/utils/ios-cmdline-tools/CtrlProxyCodesignVerifier";

/**
 * Deterministic fake for the pre-launch codesign/notarization gate (issue
 * #4760) so unit tests never spawn a real `codesign`/`spctl` process. Defaults
 * to a fully-verified outcome; set fields to simulate failures, or `throwError`
 * to simulate a missing/broken toolchain.
 */
export class FakeCtrlProxyCodesignVerifier implements CtrlProxyCodesignVerifier {
  public outcome: CodesignVerificationOutcome = {
    verified: true,
    notarized: true,
    teamId: "ABCDE12345",
    detail: "",
  };
  public throwError: Error | null = null;
  public verifiedPaths: string[] = [];

  public async verifyAppBundle(appBundlePath: string): Promise<CodesignVerificationOutcome> {
    this.verifiedPaths.push(appBundlePath);
    if (this.throwError) {
      throw this.throwError;
    }
    return this.outcome;
  }
}
