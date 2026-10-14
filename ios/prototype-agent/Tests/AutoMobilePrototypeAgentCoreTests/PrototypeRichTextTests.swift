@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRichTextTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private func fixture(_ path: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: fixtures.appendingPathComponent(path)))
    }

    func testSharedSpanRefusalsMatchTheContractPathsAndMessages() throws {
        struct Invalid: Decodable {
            let spec: JSONValue
            let expectedPath: String
            let expectedMessage: String
        }
        for name in ["neither", "and-text", "empty-array", "too-many", "empty-text"] {
            let invalid = try JSONDecoder().decode(
                Invalid.self,
                from: Data(contentsOf: fixtures.appendingPathComponent("invalid/text-spans-\(name).json"))
            )
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(invalid.spec))) { error in
                guard case let DecodingError.dataCorrupted(context) = error else {
                    return XCTFail("Expected a guard refusal, got \(error)")
                }
                XCTAssertEqual(context.debugDescription, "\(invalid.expectedPath): \(invalid.expectedMessage)")
            }
        }
    }

    func testNullTextOrSpansCannotBypassTheExactlyOneGuard() {
        for fields in [#""text":null"#, #""spans":null"#] {
            let json = """
            {"id":"r","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text",\(fields)}}
            """
            XCTAssertThrowsError(try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8)))
        }
    }

    func testSharedStateDataAndRepeatBindingsResolveEachSpan() throws {
        let spec = try fixture("valid/text-spans-placeholders.json")
        let text = try XCTUnwrap(spec.root.children?.first)
        XCTAssertEqual(text.spans?.map(\.text), ["{name}", "Heading", "0: First"])
        XCTAssertEqual(text.plainText(state: spec.state ?? [:], pager: nil), "AdaHeading0: First")
        XCTAssertEqual(text.accessibilityLabel(state: spec.state ?? [:], pager: nil, tappable: false), "AdaHeading0: First")
    }

    func testPlaceholdersCannotCrossSpanBoundariesAndDescriptionsStillWin() throws {
        let text = try node(#"{"type":"text","spans":[{"text":"{na"},{"text":"me}"}],"contentDescription":"Read {name}"}"#)
        let state: [String: JSONValue] = ["name": .string("Ada")]
        XCTAssertEqual(text.plainText(state: state, pager: nil), "{name}")
        XCTAssertEqual(text.accessibilityLabel(state: state, pager: nil, tappable: false), "Read Ada")
        XCTAssertEqual(PrototypeRichText.runs(node: text, state: state, pager: nil, nodeKey: "n")?.map(\.text), ["{na", "me}"])
    }

    func testMappingKeepsAuthoredStylesAndOnlyTappableRunsHavePrivateLinks() throws {
        let text = try node(##"{"type":"text","spans":[{"text":"Hi {name}","style":{"color":{"light":"primary","dark":"#FFFFFF"},"fontWeight":700,"fontStyle":"italic","textDecoration":"underlineLineThrough","textSize":18,"letterSpacing":0.5,"fontFamily":"serif","background":"#123456"},"onTap":[{"type":"emit","name":"terms"}]},{"text":" plain"}]}"##)
        let runs = try XCTUnwrap(PrototypeRichText.runs(node: text, state: ["name": .string("Ada")], pager: nil, nodeKey: "a /?雪"))
        XCTAssertEqual(runs.map(\.text), ["Hi Ada", " plain"])
        let style = try XCTUnwrap(runs[0].style)
        XCTAssertEqual(style.color, .modes(light: "primary", dark: "#FFFFFF"))
        XCTAssertEqual(style.background, .single("#123456"))
        XCTAssertEqual(style.fontWeight, 700)
        XCTAssertEqual(style.fontStyle, "italic")
        XCTAssertEqual(style.textDecoration, "underlineLineThrough")
        XCTAssertEqual(style.textSize, 18)
        XCTAssertEqual(style.letterSpacing, 0.5)
        XCTAssertEqual(style.fontFamily, .keyword("serif"))
        let url = try XCTUnwrap(runs[0].link)
        XCTAssertEqual(url.scheme, PrototypeRichText.linkScheme)
        XCTAssertEqual(url.path, "/0")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "a /?雪")
        XCTAssertNil(runs[1].link)
        XCTAssertNil(runs[1].style)
        XCTAssertNil(PrototypeRichText.link(nodeKey: "n", index: -1))
    }

    func testPlainTextAndEmptyPlainTextKeepTheirExistingSemantics() throws {
        let text = try node(#"{"type":"text","text":"Hello {name}"}"#)
        XCTAssertNil(text.spans)
        XCTAssertNil(PrototypeRichText.runs(node: text, state: [:], pager: nil, nodeKey: "n"))
        XCTAssertEqual(text.plainText(state: ["name": .string("Ada")], pager: nil), "Hello Ada")
        let empty = try fixture("valid/text-spans-plain-text.json")
        XCTAssertEqual(empty.root.text, "")
        XCTAssertEqual(empty.root.plainText(state: [:], pager: nil), "")
        XCTAssertNil(empty.root.accessibilityLabel(state: [:], pager: nil, tappable: false))
    }

    func testSpanActionsAreValidatedLikeNodeActions() throws {
        let text = try fixture("valid/text-spans-tappable.json").root
        XCTAssertNil(PrototypeStateValidator.rejection(root: text, state: ["accepted": .bool(false)]))
        XCTAssertEqual(PrototypeStateValidator.rejection(root: text, state: [:]), "Toggle requires a boolean state key")
    }

    func testRepeatBindsSpanActionNamesKeysAndValuesThroughExistingFunctions() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"{"id":"r","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column","repeat":{"as":"item","items":[{"title":"Terms","key":"accepted","value":true}]},"children":[{"type":"text","spans":[{"text":"{index}: {item.title}","onTap":[{"type":"emit","name":"{item.title}"},{"type":"setState","key":"{item.key}","value":"{item.value}"}]}]}]}}"#.utf8))
        let span = try XCTUnwrap(spec.root.children?.first?.spans?.first)
        XCTAssertEqual(span.text, "0: Terms")
        XCTAssertEqual(span.onTap?.first?.name, "Terms")
        XCTAssertEqual(span.onTap?.last?.key, "accepted")
        XCTAssertEqual(span.onTap?.last?.value, .bool(true))
    }

    func testHostExpandedComponentSpansDecode() throws {
        struct Expanded: Decodable { let expanded: PrototypeSpec }
        let expanded = try JSONDecoder().decode(
            Expanded.self, from: Data(contentsOf: fixtures.appendingPathComponent("components/expand/text-spans-props.json"))
        ).expanded
        XCTAssertEqual(expanded.root.plainText(state: [:], pager: nil), "Terms")
        XCTAssertEqual(expanded.root.spans?.first?.onTap?.first?.name, "terms")
    }

    func testResolvedEmptyTextIsAllowedAndPagerUsesTheSameInterpolation() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"{"id":"r","data":{"empty":""},"window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","spans":[{"text":"{data:/empty}"},{"text":"{page}/{pageCount} {name}"}]}}"#.utf8))
        XCTAssertEqual(spec.root.spans?.first?.text, "")
        XCTAssertEqual(spec.root.plainText(state: ["name": .string("")], pager: PagerPosition(page: 1, count: 3)), "2/3 ")
    }

    func testSpanFontAssetsUseTheExistingMissingAssetTracking() throws {
        let text = try node(#"{"type":"text","spans":[{"text":"a","style":{"fontFamily":{"asset":"custom"}}}]}"#)
        XCTAssertEqual(text.fontAssetIds(), ["custom"])
        XCTAssertEqual(PrototypeRichText.runs(node: text, state: [:], pager: nil, nodeKey: "n")?.first?.style?.fontFamily, .asset("custom"))
    }
}
