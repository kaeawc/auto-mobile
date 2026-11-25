@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Inserted data, row and derived values are never read again as placeholders (#18628), mirroring
/// Android's `PrototypeInsertedTextLiteralTest` and `PrototypeTextShieldTest`.
final class PrototypeInsertedTextLiteralTests: XCTestCase {
    private let mark = PrototypeTextShield.mark

    private let shared = #"""
    "state":{"secret":"LEAK","input":"","choice":"a"},
    "derive":{"x":{"of":{"data":"/n"},"format":{"number":{}}}},
    "data":{"note":"{secret}","n":7,
     "items":[{"id":0,"title":"{secret}"},{"id":1,"title":"{derived:x}"}]}
    """#

    private func make(_ root: String) throws -> PrototypeSpec {
        let window = #"{"id":"literal","window":{"placement":{"type":"fullscreen"}},"#
        let json = window + shared + #","root":"# + root + "}"
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func context(_ spec: PrototypeSpec) -> PrototypeDerivedContext {
        PrototypeDerivedContext(entries: spec.derive ?? [:], data: spec.data, values: spec.derivedValues)
    }

    private func nodes(_ node: PrototypeNode) -> [PrototypeNode] {
        [node] + ((node.children ?? []) + [node.child].compactMap(\.self)).flatMap(nodes)
    }

    private func tagged(_ spec: PrototypeSpec, _ tag: String) -> [PrototypeNode] {
        nodes(spec.root).filter { $0.testTag == tag }
    }

    private func texts(_ spec: PrototypeSpec, _ tag: String) -> [String] {
        tagged(spec, tag).map { $0.plainText(state: spec.state ?? [:], pager: nil, derived: context(spec)) }
    }

    func testShieldedValuesRoundTripExactlyAndHideEveryKeyOpeningBrace() {
        let values = ["{count}", "{derived:x}", "{data:/a}", "{item.t}", "{{a}}", "{1} {", "{\(mark)x}", ""]
        for value in values {
            XCTAssertEqual(PrototypeTextShield.unshield(PrototypeTextShield.shield(value)), value, value)
        }
        XCTAssertEqual(PrototypeTextShield.shield("{count} {1}"), "{\(mark)count} {1}")
        XCTAssertEqual(PrototypeTextShield.unshield("plain"), "plain")
        XCTAssertEqual(
            interpolatePrototypeText(
                PrototypeTextShield.shield("{secret}") + " {secret}",
                state: ["secret": .string("LEAK")],
                pager: nil
            ),
            "{secret} LEAK"
        )
    }

    func testOnlyARenderersResolutionShieldsInsertedData() {
        let root: JSONValue = .object(["type": .string("text"), "text": .string("{data:/note} {key}")])
        let data: [String: JSONValue] = ["note": .string("{key}")]
        // The default output is the shared cross-platform resolution contract.
        XCTAssertEqual(
            PrototypeDataResolver.resolveRoot(root, data: data).objectFields?["text"],
            .string("{key} {key}")
        )
        XCTAssertEqual(
            PrototypeDataResolver.resolveRoot(root, data: data, shield: true).objectFields?["text"],
            .string("{\(mark)key} {key}")
        )
    }

    func testEagerRowsDataAndDerivedValuesRenderLiterally() throws {
        let spec = try make(#"""
        {"type":"column","children":[
          {"type":"text","testTag":"authored","text":"{secret} {derived:x}"},
          {"type":"text","testTag":"data","text":"{data:/note}"},
          {"type":"topAppBar","testTag":"bar","title":"{data:/note}"},
          {"type":"column","repeat":{"items":[{"label":"{secret}"},{"label":"{derived:x}"}],"as":"item"},
           "children":[
             {"type":"text","testTag":"row","text":"{item.label}|{secret}"},
             {"type":"listItem","testTag":"head","headline":"{item.label}"}]}]}
        """#)
        let state = spec.state ?? [:]
        // Authored placeholders still resolve; an inserted `{derived:x}` stays literal.
        XCTAssertEqual(texts(spec, "authored"), ["LEAK 7"])
        XCTAssertEqual(texts(spec, "data"), ["{secret}"])
        XCTAssertEqual(
            tagged(spec, "bar").map { interpolatePrototypeText($0.title ?? "", state: state, pager: nil) },
            ["{secret}"]
        )
        XCTAssertEqual(texts(spec, "row"), ["{secret}|LEAK", "{derived:x}|LEAK"])
        let heads = tagged(spec, "head")
        XCTAssertEqual(heads.map { PrototypeTextShield.unshield($0.headline ?? "") }, ["{secret}", "{derived:x}"])
        XCTAssertEqual(heads.map { $0.announcementText(state: state, pager: nil) }, ["{secret}", "{derived:x}"])
    }

    func testLazyListRowValuesRenderLiterally() throws {
        let spec = try make(#"""
        {"type":"list","testTag":"feed","repeat":{"items":{"path":"/items"},"as":"post","key":"id"},
         "children":[{"type":"text","testTag":"row","text":"{post.title} {secret}"}]}
        """#)
        let rendered = try (0 ..< 2).map { index in
            try XCTUnwrap(PrototypeLazyList.row(node: spec.root, data: spec.data, index: index)).node
                .plainText(state: spec.state ?? [:], pager: nil, derived: context(spec))
        }
        XCTAssertEqual(rendered, ["{secret} LEAK", "{derived:x} LEAK"])
    }

    func testComponentsThatReadTheirOwnFieldsGetTheInsertedValueExactly() throws {
        let spec = try make(#"""
        {"type":"column","repeat":{"items":[{"label":"{secret}"}],"as":"item"},"children":[
          {"type":"select","testTag":"select","stateKey":"choice","label":"{item.label}",
           "options":[{"value":"a","label":"{item.label}"},{"value":"b","label":"B"}]},
          {"type":"textField","testTag":"field","stateKey":"input",
           "errorWhen":{"key":"secret","equals":"LEAK"},"errorText":"{item.label}"}]}
        """#)
        let state = spec.state ?? [:]
        let select = try XCTUnwrap(tagged(spec, "select").first)
        XCTAssertEqual(select.options?.first?.label, "{secret}")
        XCTAssertEqual(select.announcementText(state: state, pager: nil), "{secret}")
        let field = try XCTUnwrap(tagged(spec, "field").first)
        XCTAssertEqual(field.errorText, "{secret}")
    }

    func testAShownErrorMessageKeepsAnInsertedValueExactly() throws {
        let spec = try make(#"""
        {"type":"textField","testTag":"field","stateKey":"input",
         "errorWhen":{"key":"secret","equals":"LEAK"},"errorText":"{data:/note} {secret}"}
        """#)
        // Error text is shown as written, so the authored `{secret}` stays literal too.
        XCTAssertEqual(
            PrototypeFieldError.shown(spec.root, state: spec.state ?? [:], shown: []).message,
            "{secret} {secret}"
        )
    }
}
