@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeChannelRoutesTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    func testAndroidRouteCasesFirstMatchNumbersNullMissingAndSSEDefault() throws {
        // Android has route unit cases, but the shared realtime vectors only cover backoff and
        // coalescing. Mirror those cases here, including null versus missing and numeric equality.
        let routes = try json("""
        [{"when":{"pointer":"/type","equals":"message"},"actions":["a"]},
         {"when":{"pointer":"/n","equals":1},"actions":["b"]},
         {"when":{"pointer":"/typing","exists":true},"actions":["c"]},
         {"when":{"pointer":"/gone","exists":false},"actions":["d"]},
         {"actions":["e"]}]
        """)
        for (text, expected) in [
            (#"{"type":"message","typing":true}"#, "a"),
            (#"{"n":1.0,"gone":1}"#, "b"),
            (#"{"typing":false,"gone":1}"#, "c"),
            (#"{"x":1}"#, "d"), (#"{"gone":null}"#, "e"), (#""plain text""#, "d"),
        ] {
            XCTAssertEqual(try PrototypeChannelRoutes.match(routes, data: json(text), event: nil), [.string(expected)])
        }
        let sse = try json("""
        [{"when":{"event":"message"},"actions":["m"]},
         {"when":{"event":"ping"},"actions":["p"]}]
        """)
        XCTAssertEqual(PrototypeChannelRoutes.match(sse, data: .null, event: nil), [.string("m")])
        XCTAssertEqual(PrototypeChannelRoutes.match(sse, data: .null, event: "ping"), [.string("p")])
        XCTAssertNil(PrototypeChannelRoutes.match(sse, data: .null, event: "other"))
        XCTAssertNil(PrototypeChannelRoutes.match(nil, data: .null, event: nil))
    }

    func testRouteStringsAndSSEEventNamesUseExactUnicodeIdentity() throws {
        let routes: JSONValue = .array([
            .object([
                "when": .object(["pointer": .string("/value"), "equals": .string("\u{E9}")]),
                "actions": .array([.string("composed")]),
            ]),
        ])
        XCTAssertNil(PrototypeChannelRoutes.match(routes, data: .object(["value": .string("e\u{301}")]), event: nil))
        let sse: JSONValue = .array([
            .object(["when": .object(["event": .string("\u{E9}")]), "actions": .array([])]),
        ])
        XCTAssertNil(PrototypeChannelRoutes.match(sse, data: .null, event: "e\u{301}"))
    }
}
