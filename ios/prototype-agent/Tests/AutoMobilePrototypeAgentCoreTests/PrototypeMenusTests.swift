@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeMenusTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func decode(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func fixture(_ name: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("valid/\(name).json"))
        )
    }

    private func assertInvalid(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        struct Invalid: Decodable {
            let spec: JSONValue
            let expectedPath: String
            let expectedMessage: String
        }
        let wrapper = try JSONDecoder().decode(
            Invalid.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
        )
        let data = try JSONEncoder().encode(wrapper.spec)
        XCTAssertThrowsError(
            try JSONDecoder().decode(PrototypeSpec.self, from: data),
            name,
            file: file,
            line: line
        ) { error in
            guard case let DecodingError.dataCorrupted(context) = error else {
                return XCTFail("\(name): \(error)", file: file, line: line)
            }
            XCTAssertEqual(
                context.debugDescription,
                "\(wrapper.expectedPath): \(wrapper.expectedMessage)",
                file: file,
                line: line
            )
        }
    }

    func testMenuStructuralFixturesPinTheSharedPathsAndMessages() throws {
        for name in [
            "menu-no-items",
            "menu-too-many-items",
            "menu-item-unknown-field",
            "menu-divider-with-label",
            "menu-empty-label",
        ] {
            try assertInvalid(name)
        }
    }

    func testSelectStructuralFixturesPinTheSharedPathsAndMessages() throws {
        for name in ["select-one-option", "select-33-options", "select-duplicate-values"] { try assertInvalid(name) }
    }

    func testSemanticFixturesPinTheSharedPathsAndMessages() throws {
        for name in ["menu-open-state-type", "select-state-type"] { try assertInvalid(name) }
    }

    func testTheNewInvalidFixtureInventoryIsCovered() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: fixtures.appendingPathComponent("invalid").path)
            .filter { $0.hasPrefix("menu-") || $0.hasPrefix("select-") }
        XCTAssertEqual(Set(names), Set([
            "menu-no-items.json", "menu-too-many-items.json", "menu-item-unknown-field.json",
            "menu-divider-with-label.json", "menu-empty-label.json", "menu-open-state-type.json",
            "select-one-option.json", "select-33-options.json", "select-duplicate-values.json",
            "select-state-type.json",
        ]))
    }

    func testValidFixturesDecodeAndValidate() throws {
        let menu = try fixture("menu-overflow")
        XCTAssertNil(PrototypeStateValidator.rejection(root: menu.root, state: menu.state ?? [:]))
        let node = try XCTUnwrap(menu.root.children?.last)
        XCTAssertNil(node.items)
        XCTAssertEqual(node.menuItems?.count, 3)
        XCTAssertEqual(node.menuItems?.first?.entry?.icon, "share")
        XCTAssertEqual(node.menuItems?.first?.entry?.trailingText, "Send")
        guard case .divider? = node.menuItems?[1] else { return XCTFail("Divider must decode without an entry label") }
        let select = try fixture("select-dropdown")
        XCTAssertNil(PrototypeStateValidator.rejection(root: select.root, state: select.state ?? [:]))
        XCTAssertEqual(select.root.children?.first?.label, "Choice")
        XCTAssertEqual(select.root.children?.first?.options?.map(\.value), ["a", "b"])
    }

    func testMenuIsModalAndDoesNotReserveAStackSlot() throws {
        let spec = try fixture("menu-overflow")
        let root = spec.root
        let menu = try XCTUnwrap(root.children?.last)
        XCTAssertTrue(root.menuParent(of: menu) === root)
        XCTAssertFalse(root.blocksPage(state: ["open": .bool(false)], pages: [:]))
        XCTAssertTrue(root.blocksPage(state: ["open": .bool(true)], pages: [:]))
        XCTAssertEqual(root.openModals(state: ["open": .bool(true)], pages: [:]).map(\.type), ["menu"])
        XCTAssertFalse(menu.drawsInPlace { $0.holds(["open": .bool(true)]) })
        XCTAssertEqual(root.layerAccessibility(state: ["open": .bool(true)], pages: [:]), .collapsed)
        XCTAssertTrue(prototypeModalChangeEndsEditing(from: [], to: [menu]))
    }

    func testMenuSelectionClosesBeforeItsActionsAndDisabledRowsAreInert() throws {
        var session = PrototypeSession()
        let spec = try fixture("menu-overflow")
        session.show(spec)
        _ = session.change(key: "open", value: .bool(true))
        let root = spec.root
        XCTAssertNil(root.tapTarget(identifier: "overflow.1", state: session.state))
        XCTAssertNil(root.tapTarget(identifier: "overflow.2", state: session.state))
        let item = try XCTUnwrap(root.tapTarget(identifier: "overflow.0", state: session.state))
        let events = try XCTUnwrap(session.activate(item))
        XCTAssertEqual(events.map(\.name), ["change", "share"])
        XCTAssertEqual(events.first?.payload, .object(["key": .string("open"), "value": .bool(false)]))
        XCTAssertEqual(events.last?.state["open"], .bool(false))
        XCTAssertNil(root.tapTarget(identifier: "overflow.0", state: session.state))
    }

    func testInvertedOpenConditionAndItemWithoutActionsCloseLikeDialogs() throws {
        let spec = try decode("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":false},
         "root":{"type":"menu","id":"m","testTag":"m","openWhen":{"key":"open","equals":false},"items":[{"label":"Close"}]}}
        """)
        var session = PrototypeSession()
        session.show(spec)
        let target = try XCTUnwrap(spec.root.tapTarget(identifier: "m.0", state: session.state))
        XCTAssertEqual(session.activate(target)?.map(\.name), ["change"])
        XCTAssertEqual(session.state["open"], .bool(true))
        XCTAssertNil(spec.root.menuParent(of: spec.root))
    }

    func testSelectUsesRadioChangePayloadAndTestTagIdentifier() throws {
        let spec = try decode("""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"choice":"a"},
         "root":{"type":"select","id":"pick","testTag":"pick","stateKey":"choice","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}}
        """)
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertEqual(spec.root.partIdentifier("b"), "pick.b")
        let target = try XCTUnwrap(spec.root.tapTarget(identifier: "pick.b", state: session.state))
        let events = try XCTUnwrap(session.activate(target))
        XCTAssertEqual(events.map(\.name), ["change"])
        XCTAssertEqual(events.first?.payload, .object(["key": .string("choice"), "value": .string("b")]))
        XCTAssertEqual(session.activate(target)?.count, 0)
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: spec.root, state: ["choice": .number(1)]),
            "Select requires a string state key"
        )
        // Like radioGroup, a string need not be one of the options.
        XCTAssertNil(PrototypeStateValidator.rejection(root: spec.root, state: ["choice": .string("other")]))
    }

    func testMenuItemActionsParticipateInAtomicStateValidation() throws {
        let spec = try decode("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":true,"choice":"a"},
         "root":{"type":"column","children":[
           {"type":"select","stateKey":"choice","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]},
           {"type":"menu","id":"m","testTag":"m","openWhen":{"key":"open","equals":true},"items":[
             {"label":"Bad","onTap":[{"type":"setState","key":"choice","value":1}]}
           ]}
         ]}}
        """)
        var session = PrototypeSession()
        session.show(spec)
        let target = try XCTUnwrap(spec.root.tapTarget(identifier: "m.0", state: session.state))
        XCTAssertEqual(session.activate(target)?.count, 0)
        XCTAssertEqual(session.state["open"], .bool(true))
        XCTAssertEqual(session.state["choice"], .string("a"))
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: spec.root, state: ["open": .string("x"), "choice": .string("a")]),
            "Menu requires a boolean state key"
        )
    }

    func testMenuAndSelectRepeatBindings() throws {
        let spec = try decode("""
        {"id":"r","window":{"placement":{"type":"fullscreen"}},"state":{"open_1":false,"choice_1":"a"},
         "root":{"type":"column","repeat":{"as":"item","items":[{"id":1,"name":"One"}]},"children":[
           {"type":"menu","openWhen":{"key":"open_{item.id}","equals":true},"items":[
             {"label":"{item.name}","trailingText":"Item {index}","onTap":[{"type":"setState","key":"open_{item.id}","value":false}]},
             {"type":"divider"}]},
           {"type":"select","stateKey":"choice_{item.id}","label":"{item.name}","options":[{"value":"a","label":"{item.name}"},{"value":"b","label":"B"}]}
         ]}}
        """)
        let menu = try XCTUnwrap(spec.root.children?.first)
        XCTAssertEqual(menu.openCondition?.key, "open_1")
        XCTAssertEqual(menu.menuItems?.first?.entry?.label, "One")
        XCTAssertEqual(menu.menuItems?.first?.entry?.trailingText, "Item 0")
        XCTAssertEqual(menu.menuItems?.first?.entry?.onTap?.first?.key, "open_1")
        let select = try XCTUnwrap(spec.root.children?.last)
        XCTAssertEqual(select.stateKey, "choice_1")
        XCTAssertEqual(select.label, "One")
        XCTAssertEqual(select.options?.first?.label, "One")
    }

    func testRuntimeSelectValidationRejectsDuplicateValues() throws {
        let node = try JSONDecoder().decode(PrototypeNode.self, from: Data(
            #"{"type":"select","stateKey":"choice","options":[{"value":"a","label":"A"},{"value":"a","label":"Again"}]}"#
                .utf8
        ))
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: node, state: ["choice": .string("a")]),
            "Duplicate select option value"
        )
    }

    func testRepeatedMenuLabelMayResolveToEmpty() throws {
        let spec = try decode("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
         "root":{"type":"column","repeat":{"as":"it","items":[{"l":""}]},"children":[
           {"type":"menu","openWhen":{"key":"open","equals":true},"items":[{"label":"{it.l}"}]}
         ]}}
        """)
        XCTAssertEqual(spec.root.children?.first?.menuItems?.first?.entry?.label, "")
    }

    func testRepeatedSelectLabelAndOptionLabelMayResolveToEmpty() throws {
        let spec = try decode("""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"choice":"a"},
         "root":{"type":"column","repeat":{"as":"it","items":[{"l":""}]},"children":[
           {"type":"select","stateKey":"choice","label":"{it.l}",
            "options":[{"value":"a","label":"{it.l}"},{"value":"b","label":"B"}]}
         ]}}
        """)
        XCTAssertEqual(spec.root.children?.first?.label, "")
        XCTAssertEqual(spec.root.children?.first?.options?.first?.label, "")
    }

    func testMenuDataLabelMayResolveToEmpty() throws {
        let spec = try decode("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},"data":{"name":""},
         "root":{"type":"menu","openWhen":{"key":"open","equals":true},"items":[{"label":"{data:/name}"}]}}
        """)
        XCTAssertEqual(spec.root.menuItems?.first?.entry?.label, "")
    }

    func testMissingDataTrailingTextMayResolveToEmpty() throws {
        let spec = try decode("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},"data":{},
         "root":{"type":"menu","openWhen":{"key":"open","equals":true},
                 "items":[{"label":"Go","trailingText":"{data:/missing}"}]}}
        """)
        XCTAssertEqual(spec.root.menuItems?.first?.entry?.trailingText, "")
    }

    func testAuthoredEmptyMenuAndSelectTextStillFailsBeforeBinding() throws {
        let roots = [
            (
                #"{"type":"menu","openWhen":{"key":"open","equals":true},"items":[{"label":""}]}"#,
                "root.items[0].label"
            ),
            (
                #"{"type":"menu","openWhen":{"key":"open","equals":true},"items":[{"label":"Go","trailingText":""}]}"#,
                "root.items[0].trailingText"
            ),
            (
                #"{"type":"select","stateKey":"choice","label":"","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}"#,
                "root.label"
            ),
            (
                #"{"type":"select","stateKey":"choice","options":[{"value":"a","label":""},{"value":"b","label":"B"}]}"#,
                "root.options[0].label"
            ),
        ]
        for (root, path) in roots {
            XCTAssertThrowsError(try decode("""
            {"id":"m","window":{"placement":{"type":"fullscreen"}},"state":{"open":true,"choice":"a"},"root":\(root)}
            """)) { error in
                guard case let DecodingError.dataCorrupted(context) = error else {
                    return XCTFail("Unexpected error: \(error)")
                }
                XCTAssertEqual(context.debugDescription, "\(path): Invalid string value")
            }
        }
    }

    func testSurfaceClampsBothAxesAndResolvesEndForRTL() {
        let window = CGSize(width: 300, height: 400)
        let surface = CGSize(width: 120, height: 160)
        XCTAssertEqual(
            PrototypeMenus
                .origin(anchor: CGRect(x: 20, y: 30, width: 200, height: 40), surface: surface, window: window),
            CGPoint(x: 100, y: 70)
        )
        XCTAssertEqual(
            PrototypeMenus
                .origin(
                    anchor: CGRect(x: 20, y: 30, width: 200, height: 40),
                    surface: surface,
                    window: window,
                    rightToLeft: true
                ),
            CGPoint(x: 20, y: 70)
        )
        XCTAssertEqual(
            PrototypeMenus
                .origin(anchor: CGRect(x: 400, y: 500, width: 100, height: 100), surface: surface, window: window),
            CGPoint(x: 180, y: 240)
        )
        XCTAssertEqual(
            PrototypeMenus.origin(anchor: .zero, surface: CGSize(width: 500, height: 600), window: window),
            .zero
        )
    }

    func testCapabilityAndTransientSelectVisibility() throws {
        XCTAssertEqual(PrototypeAgentProtocol.menusCapability, "prototype_menus_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.menusCapability))
        let spec = try fixture("select-dropdown")
        let select = try XCTUnwrap(spec.root.children?.first)
        XCTAssertTrue(spec.root.visibleSelect(select, state: spec.state ?? [:], pages: [:]))
        let replacement = try fixture("select-dropdown")
        XCTAssertFalse(replacement.root.visibleSelect(select, state: replacement.state ?? [:], pages: [:]))
    }
}
