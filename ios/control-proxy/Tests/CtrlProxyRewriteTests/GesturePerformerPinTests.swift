@testable import CtrlProxyRewrite
import XCTest

final class GesturePerformerPinTests: XCTestCase {
    func testPrivacyAliasesCanonicalizeWithoutNormalizingOtherNames() {
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "photos-add"), "photos")
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "contacts-limited"), "contacts")
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "location-always"), "location")
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "Camera"), "Camera")
        XCTAssertEqual(GesturePerformer.canonicalPrivacyResourceName(for: "unknown"), "unknown")
    }

    func testPrivacyExpansionPreservesAliasesAndRejectsUnknownNames() {
        XCTAssertEqual(GesturePerformer.expandedPrivacyResourceNames(for: "all"), [
            "camera", "photos", "microphone", "contacts", "location", "calendar", "reminders",
            "media-library", "homekit", "focus", "local-network", "bluetooth", "keyboard-network",
            "health", "user-tracking",
        ])
        for name in ["camera", "photos-add", "contacts-limited", "location-always"] {
            XCTAssertEqual(GesturePerformer.expandedPrivacyResourceNames(for: name), [name])
        }
        XCTAssertNil(GesturePerformer.expandedPrivacyResourceNames(for: "Camera"))
        XCTAssertNil(GesturePerformer.expandedPrivacyResourceNames(for: "unknown"))
        XCTAssertNil(GesturePerformer.expandedPrivacyResourceNames(for: ""))
    }
}
