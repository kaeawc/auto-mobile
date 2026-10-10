@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Hunt: `interpolatePrototypeText` must behave like Android's single-pass scan
/// (`interpolatePrototypeText` in PrototypeRenderModel.kt, pinned by PrototypeRenderModelTest).
final class HuntInterpolationTests: XCTestCase {
    /// Android replaces each `{key}` token once, left to right; a substituted value is never scanned
    /// again. A value that itself spells `{other}` (text a user typed into a bound field) must show
    /// literally. iOS replaces key by key over the whole string, so the value is re-expanded, and
    /// which way depends on the dictionary's iteration order.
    func testSubstitutedValueIsNotScannedForPlaceholdersAgain() {
        let state: [String: JSONValue] = ["a": .string("{b}"), "b": .string("{a}")]
        XCTAssertEqual(interpolatePrototypeText("{a}{b}", state: state, pager: nil), "{b}{a}")
    }

    /// Android: outside a pager `{page}` / `{pageCount}` stay literal even when state has keys of
    /// those names (PrototypeRenderModelTest `interpolation resolves page tokens only inside a pager`).
    func testPageTokensStayLiteralOutsideAPagerEvenWithMatchingStateKeys() {
        let state: [String: JSONValue] = ["page": .number(2), "pageCount": .number(5)]
        XCTAssertEqual(
            interpolatePrototypeText("{page}/{pageCount}", state: state, pager: nil),
            "{page}/{pageCount}"
        )
    }
}
