@testable import AutoMobileSDK
import XCTest

/// Pins which UIWindow subclasses the in-process walker must skip when choosing the
/// window to snapshot (issue #5560). iOS keeps empty system overlay windows
/// (`UITextEffectsWindow`, `UIRemoteKeyboardWindow`) at a *higher* window level than
/// the app's content once any text input appears; selecting purely by window level
/// would then snapshot that empty overlay and hide the entire app tree. Foundation-only
/// so it runs on the macOS `swift test` destination.
final class WindowClassificationTests: XCTestCase {
    func testTextEffectsAndKeyboardOverlaysAreNonContent() {
        XCTAssertTrue(WindowClassification.isNonContentWindow(className: "UITextEffectsWindow"))
        XCTAssertTrue(WindowClassification.isNonContentWindow(className: "UIRemoteKeyboardWindow"))
    }

    func testAppAndSystemAlertWindowsRemainContent() {
        XCTAssertFalse(WindowClassification.isNonContentWindow(className: "UIWindow"))
        XCTAssertFalse(WindowClassification.isNonContentWindow(className: "UIStatusBarWindow"))
        XCTAssertFalse(WindowClassification.isNonContentWindow(className: "MyAppWindow"))
    }
}
