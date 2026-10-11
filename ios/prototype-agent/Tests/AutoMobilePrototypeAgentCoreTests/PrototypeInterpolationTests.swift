@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `interpolatePrototypeText` must behave like Android's single-pass scan
/// (`interpolatePrototypeText` in PrototypeRenderModel.kt, pinned by PrototypeRenderModelTest).
final class PrototypeInterpolationTests: XCTestCase {
    /// A substituted value that spells `{other}` (text a user typed into a bound field) shows
    /// literally; it is never scanned again, whatever the dictionary's iteration order.
    func testSubstitutedValueIsNotScannedForPlaceholdersAgain() {
        let state: [String: JSONValue] = ["a": .string("{b}"), "b": .string("{a}")]
        XCTAssertEqual(interpolatePrototypeText("{a}{b}", state: state, pager: nil), "{b}{a}")
    }

    /// Outside a pager `{page}` / `{pageCount}` stay literal even when state has keys of those names.
    func testPageTokensStayLiteralOutsideAPagerEvenWithMatchingStateKeys() {
        let state: [String: JSONValue] = ["page": .number(2), "pageCount": .number(5)]
        XCTAssertEqual(
            interpolatePrototypeText("{page}/{pageCount}", state: state, pager: nil),
            "{page}/{pageCount}"
        )
    }

    /// Inside a pager the pager position wins over same-named state keys (one-based page).
    func testPageTokensResolveFromThePagerInsideOne() {
        let state: [String: JSONValue] = ["page": .number(9), "pageCount": .number(9)]
        XCTAssertEqual(
            interpolatePrototypeText("{page}/{pageCount}", state: state, pager: PagerPosition(page: 1, count: 5)),
            "2/5"
        )
    }

    /// The same input/expected pairs as PrototypeRenderModelTest
    /// `interpolation substitutes only well formed identifier tokens`.
    func testTokenGrammarMatchesAndroid() {
        let state: [String: JSONValue] = [
            "a": .string("A"), "b_2": .string("B"), "_x": .string("X"),
            "n": .number(3), "f": .number(1.5), "t": .bool(true),
            "nest": .string("{a}"), "big": .number(12_345_678), "zero": .number(-0.0),
            "small": .number(0.00001),
        ]
        let cases: [(String, String)] = [
            ("", ""),
            ("plain } text ] {", "plain } text ] {"),
            ("{a}", "A"),
            ("{a}{b_2}{_x}", "ABX"),
            ("}{a}{", "}A{"),
            ("{{a}}", "{A}"),
            ("{a", "{a"),
            ("{}", "{}"),
            ("{1a}", "{1a}"),
            ("{a-b}", "{a-b}"),
            ("{ a }", "{ a }"),
            ("{missing}", "{missing}"),
            ("{n} {f} {t}", "3 1.5 true"),
            ("{big} {zero} {small}", "12345678 0 0.00001"),
            ("{nest}", "{a}"),
            ("{page}/{pageCount}", "{page}/{pageCount}"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(interpolatePrototypeText(input, state: state, pager: nil), expected, input)
        }
    }

    /// A combining mark after a brace is a separate scalar, not part of the token.
    func testCombiningMarkAfterBraceDoesNotBreakScan() {
        let state: [String: JSONValue] = ["a": .string("A")]
        XCTAssertEqual(interpolatePrototypeText("{a}\u{301}", state: state, pager: nil), "A\u{301}")
        XCTAssertEqual(interpolatePrototypeText("}\u{301}{a}", state: state, pager: nil), "}\u{301}A")
    }
}
