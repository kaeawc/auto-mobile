import Foundation
import XCTest

/// Differential parity for the VoiceOver providers (rewrite Phase 4C). The reference's
/// public `final class` providers were ported to internal `Sendable` structs behind
/// `Sendable` protocols. The macOS-verifiable surface is the state-read delegation
/// (exact defaults key + domain), the typed error strings, and the `#else` stubs —
/// the XCUITest Settings automation in `DefaultVoiceOverToggle` is Phase-7 only.
final class VoiceOverParityTests: XCTestCase {
    func testStateReadDelegatesToSameKeyAndDomain() {
        for configured in [true, false] {
            let reference = ReferenceVoiceOver.stateRead(configuredRunning: configured)
            let rewrite = RewriteVoiceOver.stateRead(configuredRunning: configured)

            XCTAssertEqual(reference.result, configured)
            XCTAssertTrue(
                reference == rewrite,
                "state-read delegation diverged for configured=\(configured): reference=\(reference) rewrite=\(rewrite)"
            )
            // The exact key + domain are what make VoiceOver-running detection work.
            XCTAssertEqual(rewrite.key, "VOTIsRunningKey")
            XCTAssertEqual(rewrite.domain, "com.apple.Accessibility")
        }
    }

    func testToggleErrorDescriptionsMatch() {
        let reference = ReferenceVoiceOver.toggleErrorDescriptions()
        let rewrite = RewriteVoiceOver.toggleErrorDescriptions()

        XCTAssertEqual(reference.switchNotFound, rewrite.switchNotFound)
        XCTAssertEqual(reference.unsupportedPlatform, rewrite.unsupportedPlatform)
        XCTAssertEqual(rewrite.switchNotFound, "VoiceOver toggle row not found in Settings (locale or layout drift)")
        XCTAssertEqual(rewrite.unsupportedPlatform, "VoiceOver Settings toggle is only available on iOS devices")
    }

    func testMacOSStubsMatch() {
        // On the macOS host the iOS branches are excluded: the defaults reader returns
        // false, and the toggle throws unsupportedPlatform.
        XCTAssertEqual(ReferenceVoiceOver.systemDefaultsReaderBool(), RewriteVoiceOver.systemDefaultsReaderBool())
        XCTAssertFalse(RewriteVoiceOver.systemDefaultsReaderBool())

        XCTAssertEqual(ReferenceVoiceOver.defaultToggleErrorDescription(), RewriteVoiceOver.defaultToggleErrorDescription())
        XCTAssertEqual(RewriteVoiceOver.defaultToggleErrorDescription(), "VoiceOver Settings toggle is only available on iOS devices")
    }
}
