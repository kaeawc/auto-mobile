@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeTextFieldOptionsTests: XCTestCase {
    private func node(_ fields: String = "") throws -> PrototypeNode {
        try JSONDecoder().decode(
            PrototypeNode.self,
            from: Data("{\"type\":\"textField\",\"stateKey\":\"value\"\(fields)}".utf8)
        )
    }

    private func options(_ fields: String = "") throws -> PrototypeTextFieldOptions {
        try PrototypeTextFieldOptions(node: node(fields))
    }

    func testSharedFixtureDecodesEveryTextFieldOption() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/text-field-options.json")
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
        let nodes = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(nodes.count, 4)
        XCTAssertEqual(nodes.map(\.stateKey), ["name", "quantity", "password", "notes"])
        XCTAssertEqual(nodes.map(\.label), ["Name", nil, nil, nil])
        XCTAssertEqual(nodes.map(\.variant), ["outlined", "filled", nil, nil])
        XCTAssertEqual(nodes.map(\.supportingText), ["Your full name", nil, nil, nil])
        XCTAssertEqual(nodes.map(\.keyboardType), ["text", "number", "password", nil])
        XCTAssertEqual(nodes.map(\.secure), [nil, nil, true, nil])
        XCTAssertEqual(nodes.map(\.multiline), [nil, nil, nil, true])
        XCTAssertEqual(nodes.map(\.minLines), [nil, nil, nil, 2])
        XCTAssertEqual(nodes.map(\.maxLines), [nil, nil, nil, 5])
        XCTAssertEqual(nodes.map(\.maxLength), [nil, 4, nil, nil])
        XCTAssertEqual(PrototypeTextFieldOptions(node: nodes[0]).supportingAccessibilityValue, "Your full name")
        XCTAssertEqual(PrototypeTextFieldOptions(node: nodes[3]).lineRange, 2 ... 5)
    }

    func testKeyboardMappingAndSecureInputAreIndependent() throws {
        for keyboard in ["text", "number", "decimal", "email", "phone", "url"] {
            let value = try options(",\"keyboardType\":\"\(keyboard)\"")
            XCTAssertEqual(value.keyboard.rawValue, keyboard)
            XCTAssertFalse(value.isSecure)
        }
        let password = try options(",\"keyboardType\":\"password\",\"secure\":false")
        XCTAssertEqual(password.keyboard, .text)
        XCTAssertTrue(password.isSecure)
        let secure = try options(",\"secure\":true,\"keyboardType\":\"number\"")
        XCTAssertTrue(secure.isSecure)
        XCTAssertEqual(secure.keyboard, .number)
        XCTAssertFalse(try options(",\"secure\":false").isSecure)
        XCTAssertEqual(try options().keyboard, .text)
    }

    func testLegacyFieldKeepsNativeChromeAndUnboundedInput() throws {
        let value = try options(",\"placeholder\":\"Name\"")
        XCTAssertFalse(value.usesDrawnChrome)
        XCTAssertFalse(value.isSecure)
        XCTAssertFalse(value.isMultiline)
        XCTAssertNil(value.lineRange)
        XCTAssertNil(value.maxLength)
        XCTAssertNil(value.supportingAccessibilityValue)
        XCTAssertNil(value.counterText(for: "Ada"))
        XCTAssertEqual(value.clip("A😀e\u{0301}"), "A😀e\u{0301}")
    }

    func testEachChromeOptionOptsIntoDrawing() throws {
        for fields in [
            ",\"label\":\"Name\"", ",\"variant\":\"filled\"",
            ",\"variant\":\"outlined\"", ",\"supportingText\":\"Help\"", ",\"maxLength\":4",
        ] {
            XCTAssertTrue(try options(fields).usesDrawnChrome, fields)
        }
        XCTAssertFalse(try options(",\"keyboardType\":\"email\",\"multiline\":true").usesDrawnChrome)
    }

    func testMultilineDefaultsAndExplicitBounds() throws {
        let unbounded = try options(",\"multiline\":true")
        XCTAssertTrue(unbounded.isMultiline)
        XCTAssertEqual(unbounded.lineRange, 1 ... Int.max)
        XCTAssertEqual(try options(",\"multiline\":true,\"minLines\":3").lineRange, 3 ... Int.max)
        XCTAssertEqual(try options(",\"multiline\":true,\"maxLines\":4").lineRange, 1 ... 4)
        XCTAssertEqual(try options(",\"multiline\":true,\"minLines\":2,\"maxLines\":2").lineRange, 2 ... 2)
        XCTAssertNil(try options(",\"multiline\":false").lineRange)
    }

    func testClipCountsUTF16AndNeverSplitsASurrogatePair() throws {
        let two = try options(",\"maxLength\":2")
        XCTAssertEqual(two.clip("abcd"), "ab")
        XCTAssertEqual(two.clip("a😀b"), "a")
        XCTAssertEqual(two.clip("😀b"), "😀")
        XCTAssertEqual(two.clip(""), "")
        XCTAssertEqual(two.counterText(for: "😀"), "2/2")
        XCTAssertEqual(two.counterText(for: "a😀"), "3/2")
        let three = try options(",\"maxLength\":3")
        XCTAssertEqual(three.clip("a😀b"), "a😀")
        XCTAssertEqual(three.clip("e\u{0301}xy"), "e\u{0301}x")
        XCTAssertEqual(three.counterText(for: "e\u{0301}"), "2/3")
        XCTAssertEqual(three.counterText(for: ""), "0/3")
        XCTAssertEqual(try options(",\"maxLength\":1").clip("😀"), "")
    }

    func testAccessibilityHintPreservesSupportingTextWithoutALimit() {
        XCTAssertEqual(PrototypeTextFieldOptions.accessibilityHint(supportingText: nil, count: 3, maxLength: nil), "")
        XCTAssertEqual(
            PrototypeTextFieldOptions.accessibilityHint(supportingText: "Your name", count: 3, maxLength: nil),
            "Your name"
        )
    }

    func testAccessibilityHintAddsCounterAfterSupportingText() {
        XCTAssertEqual(
            PrototypeTextFieldOptions.accessibilityHint(supportingText: "Your name", count: 3, maxLength: 4),
            "Your name. 3 of 4 characters"
        )
        XCTAssertEqual(
            PrototypeTextFieldOptions.accessibilityHint(supportingText: nil, count: 0, maxLength: 4),
            "0 of 4 characters"
        )
        XCTAssertEqual(
            PrototypeTextFieldOptions.accessibilityHint(supportingText: "", count: "😀".utf16.count, maxLength: 4),
            "2 of 4 characters"
        )
    }

    func testCapabilityIsAdvertisedAdditively() {
        XCTAssertEqual(PrototypeAgentProtocol.textFieldOptionsCapability, "prototype_text_field_options_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.textFieldOptionsCapability))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.dataModelCapability))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.textFieldOptionsCapability))
    }
}
