@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeContentTransitionTests: XCTestCase {
    func testTypedTextFieldDecodes() throws {
        let node = try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data(#"{"type":"text","text":"9","contentTransition":"numeric"}"#.utf8)
        )
        XCTAssertEqual(node.contentTransition, "numeric")
    }

    func testDirection() {
        for (before, after, expected) in [
            ("9", "10", "up"), ("$1,200", "$980", "down"),
            ("abc", "abd", "crossfade"), ("-3.5", "-2.5", "up"),
            ("1.2", "1.1", "down"), ("9", "9", "crossfade"),
            ("09", "9", "crossfade"), ("0", "-1", "down"),
        ] {
            XCTAssertEqual(contentTransitionDirection(previous: before, next: after), expected)
        }
    }

    func testParse() {
        XCTAssertEqual(parseContentTransitionNumber("$1,200"), 1200)
        XCTAssertEqual(parseContentTransitionNumber("-3.5"), -3.5)
        XCTAssertEqual(parseContentTransitionNumber("1.2.3"), 1.23)
        XCTAssertNil(parseContentTransitionNumber("abc"))
    }
}
