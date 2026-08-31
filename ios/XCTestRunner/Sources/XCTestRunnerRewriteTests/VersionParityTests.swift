import XCTest

// The differential parity target links BOTH the reference oracle (`XCTestRunner`) and the rewrite
// (`XCTestRunnerRewrite`). There is no type named `XCTestRunner` in either module, so module-qualified
// access (`XCTestRunner.Foo` vs `XCTestRunnerRewrite.Foo`) is unambiguous — the ctrl-proxy
// module-vs-type collision does not recur here.
import XCTestRunner
import XCTestRunnerRewrite

/// First parity assertion: the rewrite's generated version constant is byte-identical to the
/// reference's. During development the rewrite's `AutoMobileVersion.swift` is a symlink to the single
/// generated source of truth, so this both proves the dual-link harness works and guards against the
/// mid-dev version-drift hazard (a bump that staledates only the rewrite copy).
final class VersionParityTests: XCTestCase {
    func testRewriteVersionMatchesReference() {
        XCTAssertEqual(
            XCTestRunnerRewrite.AutoMobileVersion.current,
            XCTestRunner.AutoMobileVersion.current
        )
    }
}
