@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStackTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }

    private func text(_ tag: String) -> JSONValue {
        .object(["type": .string("text"), "text": .string(tag), "testTag": .string(tag)])
    }

    private func stack(_ id: String, home: JSONValue? = nil, detail: JSONValue? = nil) -> JSONValue {
        .object([
            "type": .string("stack"), "id": .string(id), "start": .string("home"),
            "screens": .object(["home": home ?? text("home"), "detail": detail ?? text("detail"),
                                "third": text("third")]),
        ])
    }

    private func column(_ children: [JSONValue]) -> JSONValue {
        .object(["type": .string("column"), "children": .array(children)])
    }

    private func spec(
        _ root: JSONValue,
        id: String = "demo",
        state: [String: JSONValue] = [:]
    )
        throws -> PrototypeSpec
    {
        try decode(PrototypeSpec.self, .object([
            "id": .string(id), "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "state": .object(state), "root": root,
        ]))
    }

    private func action(_ type: String, _ screen: String? = nil, stack id: String = "nav") throws -> PrototypeAction {
        var fields: [String: JSONValue] = ["type": .string(type), "stack": .string(id)]
        if let screen { fields["screen"] = .string(screen) }
        return try decode(PrototypeAction.self, .object(fields))
    }

    private func makeSession(_ root: JSONValue? = nil) throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(spec(root ?? stack("nav")))
        return session
    }

    func testSharedStackFixtureDecodesEveryNavigationAction() throws {
        let value = try JSONDecoder().decode(
            PrototypeSpec.self, from: Data(contentsOf: fixtures.appendingPathComponent("valid/stack-navigation.json"))
        )
        XCTAssertEqual(value.root.type, "stack")
        XCTAssertEqual(value.root.start, "home")
        XCTAssertEqual(try Set(XCTUnwrap(value.root.screens).keys), ["home", "detail", "third"])
        XCTAssertEqual(
            value.root.screens?["home"]?.children?.compactMap { $0.onTap?.first?.type },
            ["push", "pop", "popToRoot", "replace"]
        )
        var session = PrototypeSession()
        session.show(value)
        XCTAssertEqual(session.stacks["nav"], PrototypeStackSnapshot(path: ["home"]))
    }

    /// Invalid fixtures wrap the spec and expectedPath, as PrototypeThemeModesTests does.
    func testSharedInvalidStackFixturesRejectAtTheHostPath() throws {
        let names = [
            "dangling-stack.json",
            "duplicate-stack.json",
            "stack-unknown-screen.json",
            "stack-unknown-start.json",
        ]
        XCTAssertEqual(names.count, 4)
        for name in names {
            let file = fixtures.appendingPathComponent("invalid").appendingPathComponent(name)
            let wrapper = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
            guard case let .object(fields) = wrapper else { return XCTFail("Expected fixture object") }
            let value = try XCTUnwrap(fields["spec"])
            let path = try XCTUnwrap(fields["expectedPath"]?.stringValue)
            XCTAssertThrowsError(try decode(PrototypeSpec.self, value), file.lastPathComponent) { error in
                guard case let DecodingError.dataCorrupted(context) = error else { return XCTFail("\(error)") }
                XCTAssertTrue(context.debugDescription.hasPrefix(path + ":"), context.debugDescription)
            }
        }
    }

    func testPushPopReplaceAndPopToRoot() throws {
        var session = try makeSession()
        _ = try session.run([action("push", "detail"), action("push", "third")])
        XCTAssertEqual(session.stacks["nav"]?.path, ["home", "detail", "third"])
        _ = try session.run([action("pop")])
        XCTAssertEqual(session.stacks["nav"]?.path, ["home", "detail"])
        _ = try session.run([action("replace", "third")])
        XCTAssertEqual(session.stacks["nav"]?.path, ["home", "third"])
        _ = try session.run([action("popToRoot")])
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"])
        _ = try session.run([action("replace", "detail")])
        XCTAssertEqual(session.stacks["nav"]?.path, ["detail"])
        XCTAssertEqual(
            try session.run([action("popToRoot")]).first?.payload,
            .object(["screen": .string("home"), "depth": .number(1)])
        )
    }

    func testNoOpsAreSilentAndDoNotConsumeSequences() throws {
        var session = try makeSession()
        XCTAssertTrue(try session.run([action("pop"), action("popToRoot"), action("replace", "home")]).isEmpty)
        XCTAssertTrue(try session.run([
            action("push", "missing"),
            action("replace", "missing"),
            action("pop", stack: "missing"),
        ]).isEmpty)
        XCTAssertEqual(session.lastSequence, 0)
        let push = try action("push", "home")
        for _ in 1 ..< PrototypeLimits.maxStackDepth {
            XCTAssertEqual(session.run([push]).count, 1, "Same-screen push still changes depth")
        }
        XCTAssertEqual(session.stacks["nav"]?.depth, 32)
        XCTAssertTrue(session.run([push]).isEmpty)
        XCTAssertEqual(session.lastSequence, 31)
        XCTAssertEqual(try session.run([action("pop")]).first?.sequence, 32)
    }

    func testScreenEventCarriesPayloadStatePagesAndStackSnapshot() throws {
        let pager: JSONValue = .object([
            "type": .string("pager"),
            "id": .string("p"),
            "children": .array([text("page")]),
        ])
        var session = PrototypeSession()
        try session.show(spec(column([stack("nav"), pager]), state: ["n": .number(2)]))
        let event = try XCTUnwrap(session.run([action("push", "detail")]).first)
        XCTAssertEqual(event.kind, "screen_changed")
        XCTAssertEqual(event.name, "nav")
        XCTAssertEqual(event.payload, .object(["screen": .string("detail"), "depth": .number(2)]))
        XCTAssertEqual(event.state, ["n": .number(2)])
        XCTAssertEqual(event.pages, ["p": 0])
        XCTAssertEqual(event.stacks["nav"]?.path, ["home", "detail"])
        let wire = try JSONDecoder().decode(
            JSONValue.self,
            from: JSONSerialization.data(withJSONObject: event.wireObject(timestamp: 9))
        )
        guard case let .object(fields) = wire else { return XCTFail("Expected wire object") }
        XCTAssertEqual(
            fields["stacks"],
            .object(["nav": .object(["path": .array([.string("home"), .string("detail")]), "depth": .number(2)])])
        )
        _ = try session.run([action("pop")])
        XCTAssertEqual(event.stacks["nav"]?.depth, 2, "Events own immutable snapshots")
        let snapshot = session.navigationSnapshot
        let stacks = try XCTUnwrap(snapshot["stacks"] as? [String: [String: Any]])
        XCTAssertEqual(stacks["nav"]?["path"] as? [String], ["home"])
        XCTAssertEqual(stacks["nav"]?["depth"] as? Int, 1)
        XCTAssertEqual(snapshot["pages"] as? [String: Int], ["p": 0])
    }

    func testSameIdReshowClampsPathsAndResetStartsFresh() throws {
        var session = try makeSession()
        _ = try session.run([action("push", "detail"), action("push", "third")])
        let replacement: JSONValue = .object([
            "type": .string("stack"), "id": .string("nav"), "start": .string("detail"),
            "screens": .object(["detail": text("detail"), "third": text("third")]),
        ])
        try session.show(spec(replacement))
        XCTAssertEqual(session.stacks["nav"]?.path, ["detail", "third"])
        XCTAssertEqual(session.lastSequence, 2)
        try session.show(spec(replacement), reset: true)
        XCTAssertEqual(session.stacks["nav"]?.path, ["detail"])
        try session.show(spec(stack("nav", home: text("new")), id: "other"))
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"])
        try session.show(spec(stack("other")))
        XCTAssertNil(session.stacks["nav"])
        XCTAssertEqual(session.stacks["other"]?.path, ["home"])
    }

    func testReshowDropsEveryUnknownScreenAndFallsBackToStart() throws {
        var session = try makeSession()
        _ = try session.run([action("replace", "detail")])
        let root: JSONValue = .object([
            "type": .string("stack"), "id": .string("nav"), "start": .string("new"),
            "screens": .object(["new": text("new")]),
        ])
        try session.show(spec(root))
        XCTAssertEqual(session.stacks["nav"]?.path, ["new"])
        _ = session.dismiss(reason: .user)
        try session.show(spec(stack("nav")))
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"], "Dismiss and re-show starts fresh")
    }

    func testBackPrefersNestedThenLastEligibleSibling() throws {
        var session = try makeSession(column([stack("outer", detail: stack("nested")), stack("sibling")]))
        XCTAssertNil(session.stackPopTarget)
        _ = try session.run([action("push", "detail", stack: "outer"), action("push", "detail", stack: "nested")])
        XCTAssertEqual(session.stackPopTarget, "nested")
        XCTAssertEqual(session.popTopmostStack().first?.name, "nested")
        XCTAssertEqual(session.stackPopTarget, "outer")
        _ = try session.run([action("push", "detail", stack: "sibling")])
        XCTAssertEqual(session.stackPopTarget, "sibling")
        _ = session.popTopmostStack()
        _ = session.popTopmostStack()
        XCTAssertNil(session.stackPopTarget, "The hidden nested stack cannot take Back")
        XCTAssertTrue(session.popTopmostStack().isEmpty)
    }

    func testBackPrefersModalStacksIncludingInlineBottomSheet() throws {
        for type in ["dialog", "bottomSheet"] {
            let modal: JSONValue = .object([
                "type": .string(type), "openWhen": .object(["key": .string("open"), "equals": .bool(true)]),
                "child": stack("modal"),
            ])
            var session = PrototypeSession()
            try session.show(spec(column([modal, stack("inline")]), state: ["open": .bool(true)]))
            _ = try session.run([action("push", "detail", stack: "inline"), action("push", "detail", stack: "modal")])
            XCTAssertEqual(session.stackPopTarget, "modal", type)
            _ = session.change(key: "open", value: .bool(false))
            XCTAssertEqual(session.stackPopTarget, "inline", "Closed \(type) must not take Back")
        }
    }

    func testHiddenAndNoncurrentPagerStacksCannotTakeBack() throws {
        guard case var .object(hidden) = stack("hidden") else { return XCTFail("Expected stack object") }
        hidden["visibleWhen"] = .object(["key": .string("visible"), "equals": .bool(true)])
        let pager: JSONValue = .object([
            "type": .string("pager"), "id": .string("p"), "children": .array([stack("first"), stack("second")]),
        ])
        var session = PrototypeSession()
        try session.show(spec(column([pager, .object(hidden)]), state: ["visible": .bool(false)]))
        _ = try session.run([action("push", "detail", stack: "hidden"), action("push", "detail", stack: "second")])
        XCTAssertNil(session.stackPopTarget)
        _ = session.setPage("p", 1)
        XCTAssertEqual(session.stackPopTarget, "second")
    }

    func testOnlyTopScreenContributesAccessibilityAndTapTargets() throws {
        var session = try makeSession()
        let root = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(prototypeAccessibilityGrouping(type: "stack", tappable: false), .contain)
        XCTAssertEqual(
            root.currentChildEntries(path: "root", pages: session.pages, stacks: session.stacks)
                .map { $0.node.identifier },
            ["home"]
        )
        _ = try session.run([action("push", "detail")])
        XCTAssertEqual(
            root.currentChildEntries(path: "root", pages: session.pages, stacks: session.stacks)
                .map { $0.node.identifier },
            ["detail"]
        )
        XCTAssertNil(root.tapTarget(
            identifier: "home",
            state: session.state,
            pages: session.pages,
            stacks: session.stacks
        ))
        XCTAssertNotNil(root.tapTarget(
            identifier: "detail",
            state: session.state,
            pages: session.pages,
            stacks: session.stacks
        ))
        XCTAssertNil(root.tapTarget(
            identifier: "third",
            state: session.state,
            pages: session.pages,
            stacks: session.stacks
        ))
    }

    func testInactiveScreenBindingStillRejectsAtomicNavigationAndStateWrite() throws {
        let field: JSONValue = .object(["type": .string("textField"), "stateKey": .string("name")])
        var session = PrototypeSession()
        try session.show(spec(stack("nav", detail: field), state: ["name": .string("Ada")]))
        let invalid = try decode(
            PrototypeAction.self,
            .object(["type": .string("setState"), "key": .string("name"), "value": .number(2)])
        )
        XCTAssertTrue(try session.run([action("push", "detail"), invalid]).isEmpty)
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"])
        XCTAssertEqual(session.state["name"], .string("Ada"))
    }

    func testScreenMapsRespectCountNameAndTreeLimits() throws {
        let invalidScreens: [[String: JSONValue]] = [
            [:],
            ["": text("bad")],
            Dictionary(uniqueKeysWithValues: (0 ... 32).map { ("s\($0)", text("x")) }),
        ]
        for screens in invalidScreens {
            XCTAssertThrowsError(try spec(.object([
                "type": .string("stack"),
                "id": .string("nav"),
                "start": .string("s0"),
                "screens": .object(screens),
            ])))
        }
        var deep = text("leaf")
        for _ in 1 ... PrototypeLimits.maxDepth {
            deep = column([deep])
        }
        XCTAssertThrowsError(try spec(stack("nav", detail: deep)))
        let large = column(Array(repeating: text("item"), count: PrototypeLimits.maxNodes))
        XCTAssertThrowsError(try spec(stack("nav", detail: large)))
        let repeated: JSONValue = .object([
            "type": .string("column"),
            "repeat": .object(["as": .string("row"), "items": .array([.object(["x": .string("x")])])]),
            "children": .array([stack("nav")]),
        ])
        XCTAssertThrowsError(try spec(repeated))
    }

    func testStackCapabilityIsAdvertisedInHello() throws {
        XCTAssertEqual(PrototypeAgentProtocol.stackCapability, "prototype_stack_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_stack_v1"))
        var gate = PrototypeConnectionGate(token: "0123456789abcdef")
        let hello = try JSONSerialization.data(withJSONObject: ["type": "hello", "token": "0123456789abcdef"])
        guard case let .helloAccepted(result) = gate.receive(line: hello) else { return XCTFail("Hello rejected") }
        XCTAssertTrue((result["capabilities"] as? [String] ?? []).contains("prototype_stack_v1"))
    }

    func testInactiveScreensAreValidatedAndCollectedButNotDrawn() throws {
        let anchor: JSONValue = .object([
            "type": .string("bounds"),
            "bounds": .object(["x": .number(0), "y": .number(0), "width": .number(20), "height": .number(20)]),
        ])
        let anchored: JSONValue = .object([
            "type": .string("image"),
            "asset": .string("photo"),
            "anchor": anchor,
            "testTag": .string("photo"),
        ])
        let pager: JSONValue = .object([
            "type": .string("pager"),
            "id": .string("hiddenPager"),
            "children": .array([text("page")]),
        ])
        let dialog: JSONValue = .object([
            "type": .string("dialog"), "title": .string("Hidden"),
            "openWhen": .object(["key": .string("open"), "equals": .bool(true)]), "child": text("modal"),
        ])
        let font: JSONValue = .object([
            "type": .string("text"),
            "text": .string("font"),
            "style": .object(["fontFamily": .object(["asset": .string("brand")])]),
        ])
        var session = PrototypeSession()
        try session.show(spec(
            stack("nav", detail: column([anchored, pager, dialog, font])),
            state: ["open": .bool(true)]
        ))
        let root = try XCTUnwrap(session.spec?.root)
        XCTAssertEqual(session.pages, ["hiddenPager": 0])
        XCTAssertEqual(session.missingAssets(available: []), ["brand", "photo"])
        XCTAssertEqual(session.fontAssets(), ["brand"])
        XCTAssertTrue(
            root.windowAnchorLayer(state: session.state, pages: session.pages, stacks: session.stacks)
                .isEmpty
        )
        XCTAssertTrue(root.openModals(state: session.state, pages: session.pages, stacks: session.stacks).isEmpty)
        XCTAssertFalse(root.blocksPage(state: session.state, pages: session.pages, stacks: session.stacks))
        _ = try session.run([action("push", "detail")])
        XCTAssertEqual(
            root.windowAnchorLayer(state: session.state, pages: session.pages, stacks: session.stacks)
                .map { $0.node.identifier },
            ["photo"]
        )
        XCTAssertEqual(
            root.openModals(state: session.state, pages: session.pages, stacks: session.stacks).map(\.title),
            ["Hidden"]
        )
        XCTAssertTrue(root.blocksPage(state: session.state, pages: session.pages, stacks: session.stacks))
        XCTAssertEqual(root.drawnChildren(holds: session.holds, stacks: session.stacks).count, 1)
        _ = try session.run([action("pop")])
        XCTAssertTrue(
            root
                .windowAnchorLayer(
                    state: session.state,
                    pages: session.pages,
                    stacks: session.stacks,
                    retainExiting: true
                ).isEmpty,
            "Navigating back removes the previous screen's anchors immediately"
        )
    }

    func testDataAndRepeatWalkersResolveInsideScreens() throws {
        let root = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"type":"stack","id":"nav","start":"home","screens":{
          "home":{"type":"column","repeat":{"as":"row","items":{"path":"/rows"}},
            "children":[{"type":"text","text":"{row.label} {data:/title}"}]},
          "detail":{"type":"text","text":"{data:/title}"}}}
        """#.utf8))
        let data: JSONValue = .object(["title": .string("Title"), "rows": .array([.object(["label": .string("Row")])])])
        let value = try decode(PrototypeSpec.self, .object([
            "id": .string("data"), "window": .object(["placement": .object(["type": .string("fullscreen")])]),
            "data": data, "root": root,
        ]))
        XCTAssertEqual(value.root.screens?["home"]?.children?.map(\.text), ["Row Title"])
        XCTAssertEqual(value.root.screens?["detail"]?.text, "Title")
    }

    func testTopScreenBackgroundDrivesAppearanceAndEmitsContext() throws {
        let light: JSONValue = .object(["type": .string("box"), "style": .object(["background": .string("#ffffff")])])
        let dark: JSONValue = .object(["type": .string("box"), "style": .object(["background": .string("#000000")])])
        var session = try makeSession(stack("nav", home: light, detail: dark))
        XCTAssertEqual(session.appearance?.dark, false)
        let push = try action("push", "detail")
        let events = session.transition { $0.run([push]) }
        XCTAssertEqual(events.map(\.kind), ["screen_changed", "appearance_changed"])
        XCTAssertEqual(events.last?.stacks["nav"]?.path, ["home", "detail"])
        XCTAssertEqual(session.appearance?.dark, true)
    }
}
