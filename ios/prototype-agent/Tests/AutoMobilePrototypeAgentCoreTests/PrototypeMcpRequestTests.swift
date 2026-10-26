@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeMcpRequestTests: XCTestCase {
    func testGrammar() throws {
        XCTAssertEqual(
            PrototypeMcpRequest.parse(URL(string: "automobile-proto://import?request=a_1&label=Hello%20%26%20world")!),
            .importBundle(request: "a_1", label: "Hello & world")
        )
        XCTAssertEqual(
            PrototypeMcpRequest.parse(URL(string: "automobile-proto://open?request=a&id=entry")!),
            .open(request: "a", libraryId: "entry")
        )
        XCTAssertNil(PrototypeMcpRequest.parse(URL(string: "file:///Inbox/test.json")!))
        for query in ["", "?request=", "?request=bad%2Fid", "?request=" + String(repeating: "a", count: 65)] {
            XCTAssertNil(PrototypeMcpRequest.parse(URL(string: "automobile-proto://import" + query)!))
        }
    }

    func testUsableRequestAlwaysAnswersUnsupportedActions() throws {
        for suffix in [
            "open?request=r", "other?request=r", "import?request=r&label=a&label=b",
            "open?request=r&id=a&id=b", "import?request=r&request=r",
        ] {
            guard case let .unsupported(request, _) = PrototypeMcpRequest.parse(
                URL(string: "automobile-proto://" + suffix)!
            ) else { return XCTFail("Expected unsupported: \(suffix)") }
            XCTAssertEqual(request, "r")
        }
    }

    func testLabelRulesUseUTF16AndUnicodeCategories() {
        XCTAssertTrue(PrototypeMcpRequest.validLabel("  Hello  "))
        XCTAssertTrue(PrototypeMcpRequest.validLabel(String(repeating: "😀", count: 60)))
        for label in [
            "   ", "a\n b", "a\u{202E}b", "a\u{2028}b", "a\u{2029}b",
            String(repeating: "a", count: 121), String(repeating: "😀", count: 61),
        ] {
            XCTAssertFalse(PrototypeMcpRequest.validLabel(label), label)
        }
    }
}
