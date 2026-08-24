@testable import AutoMobileSDK
import Foundation
import XCTest

/// Pure-logic coverage for the attributed-string → semantic-link extraction that
/// brings iOS discovery to parity with Android (issue #5560). The extractor is
/// Foundation-only so these run on the macOS `swift test` destination; the UIKit
/// wiring that feeds it real `UITextView.attributedText` is verified on-device.
final class SemanticLinkExtractorTests: XCTestCase {
    private func linked(_ string: String, ranges: [(NSRange, String)]) -> NSAttributedString {
        let attributed = NSMutableAttributedString(string: string)
        for (range, url) in ranges {
            attributed.addAttribute(.link, value: URL(string: url) ?? url as Any, range: range)
        }
        return attributed
    }

    func testExtractsSingleLinkWithTextOccurrenceAndRange() {
        let text = "Read the Privacy Policy now."
        let range = (text as NSString).range(of: "Privacy Policy")
        let links = SemanticLinkExtractor.links(from: linked(text, ranges: [(range, "https://x/privacy")]))

        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links[0].text, "Privacy Policy")
        XCTAssertEqual(links[0].occurrence, 0)
        XCTAssertEqual(links[0].start, range.location)
        XCTAssertEqual(links[0].end, range.location + range.length)
    }

    func testDuplicateLinkTextGetsDistinctAscendingOccurrences() {
        // Mirrors the Playground demo: "Terms of Service" appears twice in one
        // owner paragraph and must be disambiguable by occurrence 0 vs 1.
        let text = "Read the Terms of Service, contact Support, or review the Terms of Service again."
        let ns = text as NSString
        let first = ns.range(of: "Terms of Service")
        let support = ns.range(of: "Support")
        let secondSearchStart = first.location + first.length
        let second = ns.range(
            of: "Terms of Service",
            options: [],
            range: NSRange(location: secondSearchStart, length: ns.length - secondSearchStart)
        )
        let links = SemanticLinkExtractor.links(from: linked(text, ranges: [
            (first, "https://x/terms-first"),
            (support, "https://x/support"),
            (second, "https://x/terms-second"),
        ]))

        XCTAssertEqual(links.map(\.text), ["Terms of Service", "Support", "Terms of Service"])
        XCTAssertEqual(links.map(\.occurrence), [0, 0, 1])
        XCTAssertEqual(links[0].start, first.location)
        XCTAssertEqual(links[2].start, second.location)
        XCTAssertNotEqual(links[0].start, links[2].start)
    }

    func testStringValuedLinkAttributeIsAlsoDiscovered() {
        let text = "See Support here."
        let range = (text as NSString).range(of: "Support")
        let attributed = NSMutableAttributedString(string: text)
        attributed.addAttribute(.link, value: "app://support", range: range)
        let links = SemanticLinkExtractor.links(from: attributed)

        XCTAssertEqual(links.map(\.text), ["Support"])
    }

    func testPlainTextYieldsNoLinks() {
        XCTAssertTrue(SemanticLinkExtractor.links(from: NSAttributedString(string: "no links here")).isEmpty)
    }

    func testAccessibilityLinkLabelsFallbackAssignsOccurrencesInOrder() {
        // SwiftUI inline links surface only as ordered accessibility elements with
        // the .link trait — no character range is available, but occurrence must
        // still increase for duplicate labels.
        let links = SemanticLinkExtractor.links(fromAccessibilityLinkLabels: [
            "Terms of Service", "Support", "Terms of Service",
        ])

        XCTAssertEqual(links.map(\.text), ["Terms of Service", "Support", "Terms of Service"])
        XCTAssertEqual(links.map(\.occurrence), [0, 0, 1])
        XCTAssertNil(links[0].start)
        XCTAssertNil(links[0].end)
    }

    func testAccessibilityLinkLabelsSkipBlankEntries() {
        let links = SemanticLinkExtractor.links(fromAccessibilityLinkLabels: ["  ", "Privacy Policy", ""])
        XCTAssertEqual(links.map(\.text), ["Privacy Policy"])
        XCTAssertEqual(links[0].occurrence, 0)
    }
}
