@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeTextFieldActionsTests: XCTestCase {
    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    func testTrailingIconImeActionAndSubmitDecode() throws {
        let field = try node(#"""
        {"type":"textField","stateKey":"q","testTag":"q","imeAction":"search",
         "trailingIcon":{"icon":"close","label":"Clear","onTap":[{"type":"setState","key":"q","value":""}]},
         "onSubmit":[{"type":"emit","name":"go"}]}
        """#)
        XCTAssertEqual(field.trailingIcon?.icon, "close")
        XCTAssertEqual(field.trailingIcon?.label, "Clear")
        XCTAssertEqual(field.trailingIcon?.onTap?.count, 1)
        XCTAssertEqual(field.onSubmit?.first?.name, "go")
        XCTAssertEqual(PrototypeTextFieldOptions(node: field).imeAction, .search)
    }

    func testOnSubmitAloneMeansDoneAndNothingAuthoredKeepsTheDefault() throws {
        let submit = try node(#"{"type":"textField","stateKey":"q","onSubmit":[{"type":"emit","name":"go"}]}"#)
        XCTAssertEqual(PrototypeTextFieldOptions(node: submit).imeAction, .done)
        let plain = try node(#"{"type":"textField","stateKey":"q"}"#)
        XCTAssertNil(PrototypeTextFieldOptions(node: plain).imeAction)
        let unknown = try node(#"{"type":"textField","stateKey":"q","imeAction":"previous"}"#)
        XCTAssertNil(PrototypeTextFieldOptions(node: unknown).imeAction)
    }

    func testLeadingIconDecodesAndIsNotATapTarget() throws {
        let field = try node(#"{"type":"textField","stateKey":"q","testTag":"q","leadingIcon":"search"}"#)
        XCTAssertEqual(field.leadingIcon, "search")
        XCTAssertNil(field.tapTarget(identifier: "q.leadingIcon", state: [:]))
        XCTAssertTrue(
            PrototypeAgentProtocol.capabilities
                .contains(PrototypeAgentProtocol.textFieldLeadingIconCapability)
        )
    }

    func testTheTrailingIconIsATapTargetByItsPartIdentifier() throws {
        let field = try node(#"""
        {"type":"textField","stateKey":"q","testTag":"q",
         "trailingIcon":{"icon":"close","label":"Clear","onTap":[{"type":"emit","name":"clear"}]}}
        """#)
        guard case let .appBarButton(button)? = field.tapTarget(identifier: "q.trailingIcon", state: [:]) else {
            return XCTFail("no tap target")
        }
        XCTAssertEqual(button.label, "Clear")
        XCTAssertNil(field.tapTarget(identifier: "q.other", state: [:]))
    }

    func testSharedFixtureDecodesAndRepeatBindsTheIconAndSubmit() throws {
        let valid = fixtures.appendingPathComponent("valid/text-field-actions.json")
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: valid))
        XCTAssertEqual(spec.root.children?.first?.trailingIcon?.label, "Clear")
        let tree = JSONValue.object([
            "type": .string("column"),
            "repeat": .object(["as": .string("item"), "items": .array([.object(["id": .string("a")])])]),
            "children": .array([.object([
                "type": .string("textField"),
                "stateKey": .string("q_{item.id}"),
                "trailingIcon": .object([
                    "icon": .string("close"), "label": .string("Clear {item.id}"),
                    "onTap": .array([.object(["type": .string("setState"), "key": .string("q_{item.id}"),
                                              "value": .string("")])]),
                ]),
                "onSubmit": .array([.object(["type": .string("emit"), "name": .string("s_{item.id}")])]),
            ])]),
        ])
        guard case let .object(expanded) = PrototypeRepeat.expand(tree),
              case let .array(children)? = expanded["children"],
              case let .object(field)? = children.first,
              case let .object(icon)? = field["trailingIcon"],
              case let .array(taps)? = icon["onTap"], case let .object(tap)? = taps.first,
              case let .array(submits)? = field["onSubmit"], case let .object(submit)? = submits.first
        else { return XCTFail("not expanded") }
        XCTAssertEqual(icon["label"], .string("Clear a"))
        XCTAssertEqual(tap["key"], .string("q_a"))
        XCTAssertEqual(submit["name"], .string("s_a"))
    }
}
