@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeMcpRequestTests: XCTestCase {
    private func url(_ string: String) throws -> URL {
        try XCTUnwrap(URL(string: string))
    }

    func testRequestFilesUseTheFilenameIdentityAndTypedArguments() {
        XCTAssertEqual(
            PrototypeMcpRequest.parseFile(Data(#"{"action":"import","label":"Demo"}"#.utf8), request: "r"),
            .importBundle(request: "r", label: "Demo")
        )
        XCTAssertEqual(
            PrototypeMcpRequest.parseFile(Data(#"{"action":"import"}"#.utf8), request: "r"),
            .importBundle(request: "r", label: nil)
        )
        XCTAssertEqual(
            PrototypeMcpRequest.parseFile(Data(#"{"action":"open","libraryId":"id"}"#.utf8), request: "r"),
            .open(request: "r", libraryId: "id")
        )
        for json in [
            "bad",
            "{}",
            #"{"action":"open"}"#,
            #"{"action":"future"}"#,
            #"{"action":"import","label":42}"#,
        ] {
            guard case .unsupported(request: "r", reason: _) = PrototypeMcpRequest
                .parseFile(Data(json.utf8), request: "r")
            else { XCTFail("Expected a typed rejection: \(json)"); continue }
        }
        XCTAssertNil(PrototypeMcpRequest.parseFile(Data("{}".utf8), request: "../bad"))
    }

    func testGrammar() throws {
        XCTAssertEqual(
            try PrototypeMcpRequest.parse(url("automobile-proto://import?request=a_1&label=Hello%20%26%20world")),
            .importBundle(request: "a_1", label: "Hello & world")
        )
        XCTAssertEqual(
            try PrototypeMcpRequest.parse(url("automobile-proto://open?request=a&id=entry")),
            .open(request: "a", libraryId: "entry")
        )
        XCTAssertNil(try PrototypeMcpRequest.parse(url("file:///Inbox/test.json")))
        for query in ["", "?request=", "?request=bad%2Fid", "?request=" + String(repeating: "a", count: 65)] {
            XCTAssertNil(try PrototypeMcpRequest.parse(url("automobile-proto://import" + query)))
        }
    }

    func testUsableRequestAlwaysAnswersUnsupportedActions() throws {
        for suffix in [
            "open?request=r", "other?request=r", "import?request=r&label=a&label=b",
            "open?request=r&id=a&id=b", "import?request=r&request=r",
        ] {
            guard case let .unsupported(request, _) = try PrototypeMcpRequest.parse(
                url("automobile-proto://" + suffix)
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
