@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSearchBarTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func decode(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func fixture(_ path: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: fixtures.appendingPathComponent(path)))
    }

    func testEverySharedValidSearchBarFixtureDecodesAndValidates() throws {
        let files = try FileManager.default.contentsOfDirectory(
            at: fixtures.appendingPathComponent("valid"), includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.hasPrefix("search-bar") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertFalse(files.isEmpty)
        for file in files {
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: file))
            XCTAssertEqual(spec.root.type, "searchBar", file.lastPathComponent)
            XCTAssertEqual(spec.root.stateKey, "query", file.lastPathComponent)
            XCTAssertNil(
                PrototypeStateValidator.rejection(root: spec.root, state: spec.state ?? [:]),
                file.lastPathComponent
            )
            var session = PrototypeSession()
            session.show(spec)
            XCTAssertTrue(session.isShown)
        }
        let full = try fixture("valid/search-bar.json").root
        XCTAssertEqual(full.placeholder, "Search")
        XCTAssertEqual(full.leadingIcon, "search")
        XCTAssertEqual(full.activeKey, "active")
        XCTAssertEqual(full.variant, "bar")
        XCTAssertEqual(full.trailingActions?.map(\.icon), ["close", "filter_list"])
        XCTAssertEqual(full.trailingActions?.map(\.label), ["Clear", "Filters"])
        XCTAssertEqual(full.trailingActions?.first?.onTap?.first?.key, "query")
        XCTAssertEqual(full.onSubmit?.first?.name, "submit")
        XCTAssertEqual(full.child?.children?.map(\.text), ["One", "Two", "Three", "Four", "Five"])
        XCTAssertEqual(try fixture("valid/search-bar-docked.json").root.variant, "docked")
        let minimal = try fixture("valid/search-bar-minimal.json").root
        XCTAssertNil(minimal.leadingIcon)
        XCTAssertNil(minimal.activeKey)
        XCTAssertNil(minimal.trailingActions)
        XCTAssertNil(minimal.onSubmit)
        XCTAssertFalse(minimal.searchBarActive(state: ["active": .bool(true)]))
    }

    func testSharedInvalidStateBindingsAreRejected() throws {
        struct Invalid: Decodable {
            let spec: PrototypeSpec
            let expectedPath: String
            let expectedMessage: String
        }
        for name in [
            "search-bar-state-key-not-string", "search-bar-state-key-undeclared",
            "search-bar-active-key-not-boolean", "search-bar-active-key-undeclared",
        ] {
            let data = try Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
            let invalid = try JSONDecoder().decode(Invalid.self, from: data)
            XCTAssertTrue(["root.stateKey", "root.activeKey"].contains(invalid.expectedPath))
            XCTAssertEqual(
                PrototypeStateValidator.rejection(root: invalid.spec.root, state: invalid.spec.state ?? [:]),
                invalid.expectedMessage, "\(name): \(invalid.expectedPath)"
            )
        }
        let missing =
            try decode(#"{"id":"s","window":{"placement":{"type":"fullscreen"}},"root":{"type":"searchBar"}}"#)
        XCTAssertEqual(
            PrototypeStateValidator.rejection(root: missing.root, state: [:]),
            "Text field requires a string state key"
        )
    }

    func testTypingUsesTheExistingChangePathAndNeverExpandsResults() throws {
        var session = PrototypeSession()
        try session.show(fixture("valid/search-bar.json"))
        _ = session.change(key: "active", value: .bool(false))
        let events = session.change(key: "query", value: .string("coffee"))
        XCTAssertEqual(session.state["query"], .string("coffee"))
        XCTAssertEqual(session.state["active"], .bool(false))
        XCTAssertEqual(events.map(\.name), ["change"])
        XCTAssertEqual(events.first?.payload, .object(["key": .string("query"), "value": .string("coffee")]))
        XCTAssertTrue(session.change(key: "query", value: .bool(true)).isEmpty)
        XCTAssertTrue(session.change(key: "active", value: .string("yes")).isEmpty)
        XCTAssertEqual(session.state["query"], .string("coffee"))
        XCTAssertEqual(session.state["active"], .bool(false))
        let root = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(session.run(root.onSubmit ?? []).map(\.name), ["submit"])
        XCTAssertEqual(
            try session.activate(.appBarButton(XCTUnwrap(root.trailingActions?.first)))?.map(\.name),
            ["change"]
        )
        XCTAssertEqual(session.state["query"], .string(""))
    }

    func testRepeatBindsKeysPlaceholderLabelsActionsAndChild() throws {
        let spec = try decode(#"""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},
         "state":{"q":"","expanded":false},
         "root":{"type":"column","repeat":{"as":"item","items":[
          {"key":"q","active":"expanded","title":"Coffee","event":"find"}]},
          "children":[{"type":"searchBar","testTag":"search","stateKey":"{item.key}",
           "activeKey":"{item.active}","placeholder":"Search {item.title}",
           "onSubmit":[{"type":"emit","name":"{item.event}"}],
           "trailingActions":[{"icon":"close","label":"Clear {item.title}",
            "onTap":[{"type":"setState","key":"{item.key}","value":"{item.title}"}]}],
           "child":{"type":"button","testTag":"result","label":"{item.title}",
            "onTap":[{"type":"toggle","key":"{item.active}"}]}}]}}
        """#)
        let search = try XCTUnwrap(spec.root.children?.first)
        XCTAssertEqual(search.stateKey, "q")
        XCTAssertEqual(search.activeKey, "expanded")
        XCTAssertEqual(search.placeholder, "Search Coffee")
        XCTAssertEqual(search.trailingActions?.first?.label, "Clear Coffee")
        XCTAssertEqual(search.trailingActions?.first?.onTap?.first?.key, "q")
        XCTAssertEqual(search.trailingActions?.first?.onTap?.first?.value, .string("Coffee"))
        XCTAssertEqual(search.onSubmit?.first?.name, "find")
        XCTAssertEqual(search.child?.label, "Coffee")
        XCTAssertEqual(search.child?.onTap?.first?.key, "expanded")
        XCTAssertNil(PrototypeStateValidator.rejection(root: spec.root, state: spec.state ?? [:]))
        let state = ["q": JSONValue.string(""), "expanded": .bool(false)]
        XCTAssertNil(search.tapTarget(identifier: "result", state: state))
        var active = state
        active["expanded"] = .bool(true)
        XCTAssertNotNil(search.tapTarget(identifier: "result", state: active))
        var session = PrototypeSession()
        session.show(spec)
        let target = try XCTUnwrap(search.tapTarget(identifier: "search.actions.0", state: session.state))
        XCTAssertEqual(session.activate(target)?.map(\.name), ["change"])
        XCTAssertEqual(session.state["q"], .string("Coffee"))
    }

    func testDataPlaceholdersBindSearchTextAndChild() throws {
        let spec = try decode(#"""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},
         "data":{"title":"Tea"},"state":{"q":"","active":true},
         "root":{"type":"searchBar","stateKey":"q","activeKey":"active",
          "placeholder":"Search {data:/title}",
          "trailingActions":[{"icon":"close","label":"Clear {data:/title}"}],
          "child":{"type":"text","text":"{data:/title}"}}}
        """#)
        XCTAssertEqual(spec.root.placeholder, "Search Tea")
        XCTAssertEqual(spec.root.trailingActions?.first?.label, "Clear Tea")
        XCTAssertEqual(spec.root.child?.text, "Tea")
    }

    func testStateValidationWalksSubmitTrailingActionsAndHiddenResults() throws {
        for member in [
            #""onSubmit":[{"type":"toggle","key":"q"}]"#,
            #""trailingActions":[{"icon":"close","label":"Clear","onTap":[{"type":"toggle","key":"q"}]}]"#,
            #""child":{"type":"button","onTap":[{"type":"toggle","key":"q"}]}"#,
        ] {
            let spec = try decode(#"""
            {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"q":"","active":false},
             "root":{"type":"searchBar","stateKey":"q","activeKey":"active",\#(member)}}
            """#)
            XCTAssertEqual(
                PrototypeStateValidator.rejection(root: spec.root, state: spec.state ?? [:]),
                "Toggle requires a boolean state key", member
            )
        }
    }

    func testHiddenResultsDoNotExposeModalsOrAnchors() throws {
        let spec = try decode(#"""
        {"id":"s","window":{"placement":{"type":"fullscreen"}},"state":{"q":"","active":false,"open":true},
         "root":{"type":"searchBar","stateKey":"q","activeKey":"active",
          "child":{"type":"column","children":[
           {"type":"dialog","openWhen":{"key":"open","equals":true}},
           {"type":"text","text":"Result","anchor":{"type":"bounds","bounds":{"x":0,"y":0,"width":10,"height":10}}}]}}}
        """#)
        var state = spec.state ?? [:]
        XCTAssertTrue(spec.root.openModals(state: state, pages: [:]).isEmpty)
        XCTAssertTrue(spec.root.layeredAnchors(state: state, pages: [:]).isEmpty)
        state["active"] = .bool(true)
        XCTAssertEqual(spec.root.openModals(state: state, pages: [:]).map(\.type), ["dialog"])
        XCTAssertEqual(spec.root.layeredAnchors(state: state, pages: [:]).count, 1)
    }

    func testTextFocusAndCapability() throws {
        let spec = try fixture("valid/search-bar-minimal.json")
        XCTAssertTrue(spec.root.containsTextField)
        XCTAssertEqual(prototypeAccessibilityGrouping(type: "searchBar", tappable: true), .contain)
        XCTAssertEqual(PrototypeAgentProtocol.searchBarCapability, "prototype_search_bar_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.searchBarCapability))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.searchBarCapability))
    }
}
