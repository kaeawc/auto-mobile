@testable import AutoMobilePrototypeAgentCore
import XCTest

/// `linkify` (#14233): the shared detection cases, `{match}` binding and the runs a text node draws.
final class PrototypeLinkifyTests: XCTestCase {
    private struct Case: Decodable {
        struct Expected: Decodable {
            let kind: String
            let text: String
            let start: Int
            let end: Int
        }

        let text: String
        let kinds: [String]
        let matches: [Expected]
    }

    func testSharedDetectionCases() throws {
        let file = PrototypeSpecFixtures.directory.appendingPathComponent("linkify/cases.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
        XCTAssertGreaterThan(cases.count, 10)
        for entry in cases {
            let found = PrototypeLinkify.matches(entry.text, kinds: entry.kinds)
            XCTAssertEqual(
                found,
                entry.matches.map { .init(kind: $0.kind, text: $0.text, start: $0.start, end: $0.end) },
                entry.text
            )
        }
    }

    func testMatchBindingFillsSetStateLiteralsAndValueBindings() throws {
        let onTap = try JSONDecoder().decode(JSONValue.self, from: Data("""
        [{"type":"setState","key":"handle","value":{"match":"text"}},
         {"type":"emit","name":"x","context":{"kind":{"match":"kind"}},"payload":{"match":"text"}},
         {"type":"setData","path":"/data/last","value":{"value":{"match":"text"}}}]
        """.utf8))
        let match = PrototypeLinkify.Match(kind: "mention", text: "@ana", start: 0, end: 4)
        let actions = try XCTUnwrap(PrototypeLinkify.actions(onTap, match: match))
        XCTAssertEqual(actions[0].value, .string("@ana"))
        XCTAssertEqual(actions[1].payload, .object(["match": .string("text")]))
        XCTAssertEqual(actions[2].value, .object(["value": .object(["match": .string("text")])]))
    }

    func testLinkifiedTextDrawsPlainAndLinkedRuns() throws {
        let node = try JSONDecoder().decode(PrototypeNode.self, from: Data("""
        {"type":"text","text":"Hi @ana!","linkify":{"kinds":["mention"],"style":{"fontWeight":700},
         "onTap":[{"type":"setState","key":"handle","value":{"match":"text"}}]}}
        """.utf8))
        let runs = try XCTUnwrap(PrototypeRichText.runs(node: node, state: [:], pager: nil, nodeKey: "t"))
        XCTAssertEqual(runs.map(\.text), ["Hi ", "@ana", "!"])
        XCTAssertNil(runs[0].link)
        XCTAssertNotNil(runs[1].link)
        XCTAssertEqual(runs[1].style?.fontWeight, 700)
        XCTAssertEqual(runs[1].actions?.first?.value, .string("@ana"))
        XCTAssertEqual(node.plainText(state: [:], pager: nil), "Hi @ana!")
    }

    func testTextWithoutAMatchStaysPlain() throws {
        let node = try JSONDecoder().decode(PrototypeNode.self, from: Data("""
        {"type":"text","text":"mail ana@example.com","linkify":{"kinds":["mention"],"onTap":[{"type":"dismiss"}]}}
        """.utf8))
        XCTAssertNil(PrototypeRichText.runs(node: node, state: [:], pager: nil, nodeKey: "t"))
    }
}
