@testable import ScreenCaptureCore
import XCTest

/// Guards the capture-time re-verification predicate that closes the windowID
/// reuse / TOCTOU gap (#4763): a recycled `CGWindowID` may resolve to a live
/// window owned by some other application, and the helper must fail closed
/// rather than capture it.
final class IsSimulatorWindowTests: XCTestCase {
    func testAcceptsSimulatorBundleIdentifier() {
        XCTAssertTrue(isSimulatorWindow(bundleIdentifier: simulatorBundleIdentifier))
        XCTAssertTrue(isSimulatorWindow(bundleIdentifier: deviceHubBundleIdentifier))
    }

    func testRejectsNonSimulatorBundleIdentifier() {
        XCTAssertFalse(isSimulatorWindow(bundleIdentifier: "com.google.Chrome"))
        XCTAssertFalse(isSimulatorWindow(bundleIdentifier: "com.1password.1password"))
        XCTAssertFalse(isSimulatorWindow(bundleIdentifier: "com.tinyspeck.slackmacgap"))
    }

    func testRejectsMissingBundleIdentifier() {
        XCTAssertFalse(isSimulatorWindow(bundleIdentifier: nil))
    }

    func testRejectsEmptyBundleIdentifier() {
        XCTAssertFalse(isSimulatorWindow(bundleIdentifier: ""))
    }
}
