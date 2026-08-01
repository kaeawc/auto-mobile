// GENERATED FILE — DO NOT EDIT.
//
// Rendered from package.json by scripts/versioning/generate-ios-version.sh.
// To change the version, bump package.json (scripts/versioning/bump-versions.sh
// does this and regenerates), then re-run the generator. CI runs
// `generate-ios-version.sh --check` and fails on drift.
import Foundation

/// Baked client version the XCTestRunner declares to the AutoMobile daemon.
///
/// The runner shares one per-uid daemon socket with the TypeScript MCP proxy and the
/// Android JUnit runner. The daemon runs a server-side version handshake (#2744) and
/// rejects a client whose release version does not match its own, so the runner needs
/// a concrete version to declare — this constant is that value.
///
/// Generated from `package.json` so it can't drift from the release it was cut from;
/// mirrors the Android runner deriving its version from the jar `Implementation-Version`.
/// The daemon compares only the release portion, so a plain `MAJOR.MINOR.PATCH` here
/// matches a source-checkout daemon carrying a `+g<sha>` dev stamp at the same release.
public enum AutoMobileVersion {
    /// The current AutoMobile release version. Generated — do not edit by hand.
    public static let current = "0.0.48"
}
