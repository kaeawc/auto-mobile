@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Route params, onEnter, onBack, setStack params and the persisted path (#14188).
final class PrototypeStackRoutesTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func actions(_ text: String) throws -> [PrototypeAction] {
        try JSONDecoder().decode([PrototypeAction].self, from: Data(text.utf8))
    }

    private func spec(onBack: Bool = false, storage: Bool = false) throws -> PrototypeSpec {
        let back = onBack ? #","onBack":[{"type":"setState","key":"confirm","value":true}]"# : ""
        let stored = storage ? #""storage":{"version":1,"keys":["stack:nav"]},"# : ""
        let text = #"""
        {"id":"routes","window":{"placement":{"type":"fullscreen"}},\#(stored)
        "state":{"loaded":0,"confirm":false,"current":5},
        "root":{"type":"stack","id":"nav","start":"feed",
        "screens":{"feed":{"type":"text","text":"Feed"},"post":{"type":"text","text":"Post {route.postId}"},
        "profile":{"type":"text","text":"Profile {route.author}"}},
        "routes":{"post":{"params":{"postId":"number"},
        "onEnter":[{"type":"setState","key":"loaded","value":"{route.postId}"}]\#(back)},
        "profile":{"params":{"author":"string"}}}}}
        """#
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(text.utf8))
    }

    private func shown(onBack: Bool = false) throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(spec(onBack: onBack))
        return session
    }

    private func push(_ screen: String, _ params: String) throws -> [PrototypeAction] {
        try actions(#"[{"type":"push","stack":"nav","screen":"\#(screen)","params":\#(params)}]"#)
    }

    private func postText(_ session: PrototypeSession) -> String? {
        session.spec?.root.screens?["post"]?.text
    }

    func testParamsAreRestoredOnPopAndBoundIntoTheTopScreen() throws {
        var session = try shown()
        _ = try session.run(push("post", #"{"postId":41}"#))
        _ = try session.run(push("profile", #"{"author":"ada"}"#))
        _ = try session.run(push("post", #"{"postId":7}"#))
        XCTAssertEqual(postText(session), "Post 7")
        XCTAssertEqual(session.state["loaded"], .number(7))
        let pop = try actions(#"[{"type":"pop","stack":"nav","force":true}]"#)
        _ = session.run(pop)
        XCTAssertEqual(session.spec?.root.screens?["profile"]?.text, "Profile ada")
        let events = session.run(pop)
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed", "post"])
        XCTAssertEqual(session.stacks["nav"]?.entries.last?.params, ["postId": .number(41)])
        XCTAssertEqual(postText(session), "Post 41")
        XCTAssertEqual(session.state["loaded"], .number(41))
        XCTAssertEqual(
            events.first?.payload,
            .object(["screen": .string("post"), "depth": .number(2), "params": .object(["postId": .number(41)])])
        )
    }

    func testOnEnterRunsAfterScreenChanged() throws {
        var session = try shown()
        let events = try session.run(push("post", #"{"postId":3}"#))
        XCTAssertEqual(events.map(\.wireKind), ["screen_changed", "emit"])
        XCTAssertEqual(events.last?.name, "change")
        XCTAssertEqual(events.last?.payload, .object(["key": .string("loaded"), "value": .number(3)]))
        XCTAssertLessThan(try XCTUnwrap(events.first?.sequence), try XCTUnwrap(events.last?.sequence))
    }

    func testOnBackInterceptsPopAndBackButForceAlwaysPops() throws {
        var session = try shown(onBack: true)
        _ = try session.run(push("post", #"{"postId":1}"#))
        let events = try session.run(actions(#"[{"type":"pop","stack":"nav"}]"#))
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed", "post"])
        XCTAssertEqual(session.state["confirm"], .bool(true))
        XCTAssertFalse(events.contains { $0.wireKind == "screen_changed" })
        XCTAssertTrue(session.interceptsBack("nav"))
        _ = session.setStates([("confirm", .bool(false))])
        _ = session.popTopmostStack()
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed", "post"])
        XCTAssertEqual(session.state["confirm"], .bool(true))
        _ = try session.run(actions(#"[{"type":"pop","stack":"nav","force":true}]"#))
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed"])
        XCTAssertFalse(session.interceptsBack("nav"))
    }

    func testPopToRootIsNeverIntercepted() throws {
        var session = try shown(onBack: true)
        _ = try session.run(push("post", #"{"postId":1}"#))
        _ = try session.run(actions(#"[{"type":"popToRoot","stack":"nav"}]"#))
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed"])
        XCTAssertEqual(session.state["confirm"], .bool(false))
    }

    func testParamsMustMatchTheDeclarationExactly() throws {
        var session = try shown()
        for params in [#"{"postId":"41"}"#, "{}", #"{"postId":1,"extra":true}"#, #"{"postId":{"state":"missing"}}"#] {
            XCTAssertTrue(try session.run(push("post", params)).isEmpty, params)
        }
        XCTAssertTrue(try session.run(push("feed", #"{"postId":1}"#)).isEmpty)
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed"])
        XCTAssertEqual(session.lastSequence, 0)
        _ = try session.run(push("post", #"{"postId":{"state":"current"}}"#))
        XCTAssertEqual(session.stacks["nav"]?.entries.last?.params, ["postId": .number(5)])
    }

    func testSetStackResolvesEveryEntryOrLeavesThePath() throws {
        var session = try shown()
        let events = try session.run(actions(#"""
        [{"type":"setStack","stack":"nav","path":[{"screen":"feed"},
        {"screen":"post","params":{"postId":{"state":"current"}}},{"screen":"profile","params":{"author":"lin"}}]}]
        """#))
        XCTAssertEqual(session.stacks["nav"]?.entries, [
            PrototypeStackPathEntry(screen: "feed"),
            PrototypeStackPathEntry(screen: "post", params: ["postId": .number(5)]),
            PrototypeStackPathEntry(screen: "profile", params: ["author": .string("lin")]),
        ])
        XCTAssertEqual(events.filter { $0.wireKind == "screen_changed" }.count, 1)
        let wire = try XCTUnwrap(session.navigationSnapshot["stacks"] as? [String: [String: Any]])
        XCTAssertEqual(wire["nav"]?["params"] as? [NSDictionary], [[:], ["postId": 5], ["author": "lin"]])
        let invalid = #"[{"screen":"feed"},{"screen":"post","params":{"postId":true}}]"#
        XCTAssertTrue(try session.run(actions(#"[{"type":"setStack","stack":"nav","path":\#(invalid)}]"#)).isEmpty)
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed", "post", "profile"])
    }

    func testStatusOmitsParamsWhenNoEntryHasAny() throws {
        let session = try shown()
        let wire = try XCTUnwrap(session.navigationSnapshot["stacks"] as? [String: [String: Any]])
        XCTAssertNil(wire["nav"]?["params"])
    }

    func testStoredPathRestoresAndAStaleScreenIsDroppedAsMismatch() throws {
        let spec = try spec(storage: true)
        for stale in [
            #"[{"screen":"feed"},{"screen":"gone"}]"#,
            #"[{"screen":"feed"},{"screen":"post","params":{"postId":"1"}}]"#,
            "[]",
            #"{"screen":"feed"}"#,
        ] {
            let result = try PrototypeStorageRestore.restore(
                spec: spec, stored: PrototypeStoredValues(version: 1, values: ["stack:nav": json(stale)])
            )
            XCTAssertEqual(result.dropped, [PrototypeStorageDrop(key: "stack:nav", reason: .mismatch)], stale)
            XCTAssertTrue(result.stacks.isEmpty, stale)
        }
        let stored = try json(#"[{"screen":"feed"},{"screen":"post","params":{"postId":41}}]"#)
        let result = PrototypeStorageRestore.restore(
            spec: spec, stored: PrototypeStoredValues(version: 1, values: ["stack:nav": stored])
        )
        XCTAssertEqual(result.applied, ["stack:nav"])
        var session = PrototypeSession()
        session.show(spec, restoredStacks: result.stacks)
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed", "post"])
        XCTAssertEqual(session.lastSequence, 0, "Restoring emits no screen_changed")
        XCTAssertEqual(postText(session), "Post 41")
        let events = session.transition { _ in [] }
        XCTAssertFalse(events.contains { $0.wireKind == "screen_changed" })
        XCTAssertEqual(session.state["loaded"], .number(41), "The restored top runs its onEnter")
        XCTAssertEqual(try PrototypeStackRoutes.storedValue(XCTUnwrap(session.stacks["nav"])), stored)
    }

    func testLifecycleDispatchStopsAtEightLevels() throws {
        let text = #"""
        {"id":"loop","window":{"placement":{"type":"fullscreen"}},
        "root":{"type":"stack","id":"nav","start":"home",
        "screens":{"home":{"type":"text","text":"Home"},"a":{"type":"text","text":"A"},"b":{"type":"text","text":"B"}},
        "routes":{"a":{"onEnter":[{"type":"push","stack":"nav","screen":"b"}]},
        "b":{"onEnter":[{"type":"push","stack":"nav","screen":"a"}]}}}}
        """#
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(text.utf8)))
        let events = try session.run(actions(#"[{"type":"push","stack":"nav","screen":"a"}]"#))
        XCTAssertEqual(session.stacks["nav"]?.depth, 2 + PrototypeStackRoutes.maxLifecycleDepth)
        XCTAssertEqual(events.count, 1 + PrototypeStackRoutes.maxLifecycleDepth)
    }

    func testRepeatRowsBindRouteParamBindings() throws {
        let row = PrototypeRepeatInstance(alias: "row", item: ["id": .number(3)], index: 1)
        let push = try json(#"{"type":"push","stack":"nav","screen":"post","params":{"postId":{"item":"id"},"n":7}}"#)
        XCTAssertEqual(row.bindAction(push).objectFields?["params"], try json(#"{"postId":{"value":3},"n":7}"#))
        let setStack = try json(
            #"{"type":"setStack","stack":"nav","path":[{"screen":"post","params":{"i":{"index":true}}}]}"#
        )
        XCTAssertEqual(
            row.bindAction(setStack).objectFields?["path"],
            try json(#"[{"screen":"post","params":{"i":{"value":1}}}]"#)
        )
        // A literal string param that is one placeholder keeps the item's type; other text renders.
        let literal = try json(
            ##"{"type":"replace","stack":"nav","screen":"post","params":{"postId":"{row.id}","label":"#{row.id}"}}"##
        )
        XCTAssertEqual(row.bindAction(literal).objectFields?["params"], try json(##"{"postId":3,"label":"#3"}"##))
    }

    func testRoutePlaceholdersBindTextTypedOperandsAndEscapedPointerSegments() {
        let fields = PrototypeRouteBinder.Fields(params: ["id": .string("a/b~c"), "n": .number(2)])
        XCTAssertEqual(fields.pointer("/data/posts/{route.id}/title"), "/data/posts/a~1b~0c/title")
        XCTAssertEqual(fields.text("{index}: {route.n} {other} {route.missing}"), "{index}: 2 {other} {route.missing}")
        XCTAssertEqual(fields.typed("{route.n}"), .number(2))
        XCTAssertEqual(fields.typed("#{route.n}"), .string("#2"))
    }

    func testRoutePlaceholdersBindUpsertDataPathsAndImageAssets() throws {
        let binder = PrototypeRouteBinder.Fields(params: ["id": .string("a/b"), "img": .string("thumb")])
        var upsert = try XCTUnwrap(
            json(#"{"type":"upsertData","path":"/data/posts/{route.id}/tags","key":"id","value":{"state":"x"}}"#)
                .objectFields
        )
        binder.action(&upsert)
        XCTAssertEqual(upsert["path"], .string("/data/posts/a~1b/tags"))
        XCTAssertEqual(upsert["key"], .string("id"))
        var image = try XCTUnwrap(json(#"{"type":"image","asset":"{route.img}"}"#).objectFields)
        binder.node(&image)
        XCTAssertEqual(image["asset"], .string("thumb"))
    }
}
