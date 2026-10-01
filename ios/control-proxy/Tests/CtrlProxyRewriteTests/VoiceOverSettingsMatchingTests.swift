@testable import CtrlProxyRewrite
import XCTest

final class VoiceOverSettingsMatchingTests: XCTestCase {
    private typealias Toggle = DefaultVoiceOverToggle

    func testIdentifierWinsOverEnglishLabel() {
        let candidates = [
            Toggle.Candidate(identifier: "other", label: "VoiceOver"),
            Toggle.Candidate(identifier: "VoiceOver", label: "localized title"),
        ]
        XCTAssertEqual(Toggle.matchingIndex(in: candidates, at: .accessibilityRow), 1)
        XCTAssertEqual(Toggle.matchingIndex(in: candidates, at: .subpageSwitch), 1)
    }

    func testEnglishLabelFallback() {
        let candidates = [
            Toggle.Candidate(identifier: "other", label: "Other"),
            Toggle.Candidate(identifier: "", label: "VoiceOver"),
        ]
        XCTAssertEqual(Toggle.matchingIndex(in: candidates, at: .accessibilityRow), 1)
    }

    func testFirstAccessibilityRowFallbackIgnoresUnknownLabel() {
        let candidates = [
            Toggle.Candidate(identifier: "", label: "localized title"),
            Toggle.Candidate(identifier: "", label: "another title"),
        ]
        XCTAssertEqual(Toggle.matchingIndex(in: candidates, at: .accessibilityRow), 0)
        XCTAssertNil(Toggle.matchingIndex(in: [], at: .accessibilityRow))
    }

    func testSingleSubpageSwitchFallbackButNoRootSwitchFallback() {
        let candidate = Toggle.Candidate(identifier: "", label: "localized title")
        XCTAssertEqual(Toggle.matchingIndex(in: [candidate], at: .subpageSwitch), 0)
        XCTAssertNil(Toggle.matchingIndex(in: [candidate], at: .directSwitch))
        XCTAssertNil(Toggle.matchingIndex(in: [candidate, candidate], at: .subpageSwitch))
        XCTAssertNil(Toggle.matchingIndex(in: [], at: .subpageSwitch))
    }

    func testDuplicateIdentifierIsAmbiguous() {
        let candidate = Toggle.Candidate(identifier: "VoiceOver", label: "localized title")
        XCTAssertNil(Toggle.matchingIndex(in: [candidate, candidate], at: .subpageSwitch))
    }
}
