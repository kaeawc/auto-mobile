@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStackTransitionsTests: XCTestCase {
    private func spec(_ transition: String = "", actions: String = "") -> Data {
        Data("""
        {"id":"a","window":{"placement":{"type":"fullscreen"}},"root":{"type":"stack","id":"nav","start":"home"\(
            transition
        ),"screens":{"home":{"type":"text","text":"x"\(actions)}}}}
        """.utf8)
    }

    private func navigationSession() throws -> PrototypeSession {
        let source =
            #"{"id":"a","window":{"placement":{"type":"fullscreen"}},"data":{"items":[]},"root":{"type":"column","children":[{"type":"stack","id":"nav","start":"home","screens":{"home":{"type":"text","text":"home"},"detail":{"type":"text","text":"detail"}}},{"type":"stack","id":"other","start":"home","screens":{"home":{"type":"text","text":"other"}}}]}}"#
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(source.utf8)))
        _ = try session.run([JSONDecoder().decode(PrototypeAction.self, from: Data(
            #"{"type":"push","stack":"nav","screen":"detail"}"#.utf8
        ))])
        return session
    }

    func testDataWritesAndUnrelatedPatchPreserveNavigation() throws {
        var session = try navigationSession()
        let entries = session.stackEntries
        let changes = session.stackChanges
        for json in [
            #"{"type":"setData","path":"/data/items","value":{"value":[]}}"#,
            #"{"type":"appendData","path":"/data/items","value":{"value":"x"}}"#,
            #"{"type":"removeData","path":"/data/items/0"}"#,
        ] {
            let events = try session.run([JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))])
            XCTAssertFalse(events.isEmpty)
            XCTAssertEqual(session.stackEntries, entries)
            XCTAssertEqual(session.stackChanges, changes)
        }
        let (outcome, _) = session.patch(id: "a", baseRevision: nil, ops: .array([
            .object(["op": .string("add"), "path": .string("/data/title"), "value": .string("new")]),
        ]))
        XCTAssertEqual(outcome, .applied(revision: session.dataRevision))
        XCTAssertEqual(session.stackEntries, entries)
        XCTAssertEqual(session.stackChanges, changes)
    }

    func testScreenRemovalResetsOnlyAffectedStackAndRetainsPrefix() throws {
        var session = try navigationSession()
        let entries = session.stackEntries
        let changes = session.stackChanges
        let (outcome, _) = try session.patch(id: "a", baseRevision: nil, ops: .array([
            JSONDecoder().decode(JSONValue.self, from: Data(
                #"{"op":"replaceNode","id":"nav","node":{"type":"stack","id":"nav","start":"home","screens":{"home":{"type":"text","text":"home"}}}}"#
                    .utf8
            )),
        ]))
        XCTAssertEqual(outcome, .applied(revision: session.dataRevision))
        XCTAssertEqual(session.stackEntries["nav"], entries["nav"].map { Array($0.prefix(1)) })
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .reset)
        XCTAssertNotEqual(session.stackChanges["nav"]?.revision, changes["nav"]?.revision)
        XCTAssertEqual(session.stackEntries["other"], entries["other"])
        XCTAssertEqual(session.stackChanges["other"], changes["other"])
    }

    func testScreenEditResetsRevisionButKeepsEntryIdentity() throws {
        var session = try navigationSession()
        let entries = session.stackEntries
        let changes = session.stackChanges
        let (outcome, _) = try session.patch(id: "a", baseRevision: nil, ops: .array([
            JSONDecoder().decode(JSONValue.self, from: Data(
                #"{"op":"replaceNode","id":"nav","node":{"type":"stack","id":"nav","start":"home","screens":{"home":{"type":"text","text":"home"},"detail":{"type":"text","text":"edited"}}}}"#
                    .utf8
            )),
        ]))
        XCTAssertEqual(outcome, .applied(revision: session.dataRevision))
        XCTAssertEqual(session.stackEntries, entries)
        XCTAssertNotEqual(session.stackChanges["nav"], changes["nav"])
        XCTAssertEqual(session.stackChanges["other"], changes["other"])
    }

    func testSwipeCancellationReturnsToRestAndEndIsInert() throws {
        var swipe = PrototypeStackSwipeState()
        swipe.update(target: "nav", revision: 4, start: 10, translation: 75, vertical: 0, width: 300, rtl: false)
        XCTAssertEqual(swipe.target, "nav")
        XCTAssertEqual(swipe.revision, 4)
        XCTAssertEqual(swipe.progress, 0.25)
        swipe.cancel()
        XCTAssertNil(swipe.target)
        XCTAssertNil(swipe.revision)
        XCTAssertEqual(swipe.progress, 0)
        XCTAssertNil(swipe.end())
        swipe.update(target: "nav", revision: 4, start: 80, translation: 75, vertical: 0, width: 300, rtl: false)
        XCTAssertNil(swipe.target)
        XCTAssertNil(swipe.end())
        swipe.update(target: "nav", revision: 4, start: 10, translation: 90, vertical: 0, width: 300, rtl: false)
        XCTAssertEqual(swipe.end()?.target, "nav")
        XCTAssertNil(swipe.target)
        XCTAssertNil(swipe.revision)
    }

    func testEnumMatchesSharedContract() throws {
        let (_, validator) = try PrototypeContractValidator.inspect(data: spec())
        let values = validator.definitions["stackTransition"]?.objectFields?["values"]
        XCTAssertEqual(values, .array(PrototypeStackTransition.allCases.map { .string($0.rawValue) }))
    }

    func testValuesDecodeOnStacksAndActions() throws {
        for transition in PrototypeStackTransition.allCases where transition != .zoom {
            let actions =
                #", "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"\#(transition.rawValue)"},{"type":"replace","stack":"nav","screen":"home","transition":"\#(transition.rawValue)"}]"#
            let data = spec(#", "transition":"\#(transition.rawValue)""#, actions: actions)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data))
            let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: data)
            XCTAssertEqual(decoded.root.transition, transition.rawValue)
            XCTAssertEqual(decoded.root.screens?["home"]?.onTap?.first?.transition, transition)
            XCTAssertEqual(decoded.root.screens?["home"]?.onTap?.last?.transition, transition)
            XCTAssertEqual(
                try PrototypeBundleCapabilities.required(data),
                (
                    ["sharedAxisX", "sharedAxisY", "fadeThrough"]
                        .contains(transition.rawValue) ? ["prototype_stack_patterns_v1"] : []
                ) +
                    ["prototype_stack_transitions_v1", "prototype_stack_v1"]
            )
        }
    }

    func testInvalidEnumsObjectsAndPopOverridesAreRejected() {
        for bad in [#""scale""#, #""futurePattern""#, #"{"type":"fade"}"#, "null"] {
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(",\"transition\":\(bad)")))
            for type in ["push", "replace"] {
                let actions = #", "onTap":[{"type":"\#(type)","stack":"nav","screen":"home","transition":\#(bad)}]"#
                XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(actions: actions)))
            }
        }
        for type in ["pop", "popToRoot"] {
            let actions = #", "onTap":[{"type":"\#(type)","stack":"nav","transition":"none"}]"#
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: spec(actions: actions)))
        }
    }

    func testMissingCapabilityFailsClosed() {
        let data = spec(#", "transition":"platform""#)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: data,
            supportedCapabilities: ["prototype_stack_v1"]
        ))
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(
            data: data,
            supportedCapabilities: ["prototype_stack_v1", "prototype_stack_transitions_v1"]
        ))
    }

    func testStrictCapabilitiesAndDefault() throws {
        for data in [
            spec(#", "transition":"platform""#),
            spec(actions: #", "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"fade"}]"#),
        ] {
            let fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectFields)
            XCTAssertEqual(
                PrototypeStrictCapabilities.required(fields),
                ["prototype_stack_v1", "prototype_stack_transitions_v1"]
            )
        }
        let fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: spec()).objectFields)
        XCTAssertEqual(PrototypeStrictCapabilities.required(fields), ["prototype_stack_v1"])
    }

    func testResolutionTable() {
        let overrides: [PrototypeStackTransition?] = [nil] + PrototypeStackTransition.allCases.map(Optional.some)
        for declared in PrototypeStackTransition.allCases {
            for override in overrides {
                for specMotion in [nil, "none", "standard", "reduced"] as [String?] {
                    for reduced in [false, true] {
                        for direction in [PrototypeStackChange.Direction.push, .pop, .replace, .reset] {
                            let chosen = override ?? declared
                            let expected: PrototypeStackAnimation = specMotion == "none" || chosen == .none ||
                                direction == .reset
                                ? .none : reduced || specMotion == "reduced" || chosen == .fade ||
                                ((chosen == .platform || chosen == .zoom) && direction == .replace) ?
                                .fade : [
                                    .sharedAxisX: .sharedAxisX,
                                    .sharedAxisY: .sharedAxisY,
                                    .fadeThrough: .fadeThrough,
                                ][chosen] ?? .slide
                            XCTAssertEqual(PrototypeStackNavigation.animation(
                                declared: declared, perAction: override, specMotion: specMotion,
                                reduceMotion: reduced, direction: direction
                            ), expected)
                        }
                    }
                }
            }
        }
    }

    func testDirectionOverridesEntryIdentityAndReloadReset() throws {
        let data =
            Data(
                #"{"id":"nav","window":{"placement":{"type":"fullscreen"}},"root":{"type":"stack","id":"nav","start":"home","transition":"slide","screens":{"home":{"type":"text","text":"home"},"detail":{"type":"text","text":"detail"}}}}"#
                    .utf8
            )
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .reset)
        let root = session.stackEntries["nav"]?.first
        func action(_ type: String, _ screen: String? = nil, transition: String? = nil) throws -> PrototypeAction {
            var fields: [String: String] = ["type": type, "stack": "nav"]
            fields["screen"] = screen
            fields["transition"] = transition
            return try JSONDecoder().decode(PrototypeAction.self, from: JSONEncoder().encode(fields))
        }
        _ = try session.run([action("push", "detail", transition: "fade")])
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .push)
        XCTAssertEqual(session.stackChanges["nav"]?.transition, .fade)
        XCTAssertEqual(session.stackEntries["nav"]?.first, root)
        _ = try session.run([action("push", "detail")])
        XCTAssertEqual(Set(session.stackEntries["nav"]?.map(\.id) ?? []).count, 3)
        _ = session.popTopmostStack()
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .pop)
        XCTAssertEqual(session.stackChanges["nav"]?.transition, .slide)
        _ = try session.run([action("replace", "home", transition: "none")])
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .replace)
        XCTAssertEqual(session.stackChanges["nav"]?.transition, PrototypeStackTransition.none)
        _ = try session.run([action("popToRoot")])
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .pop)
        XCTAssertEqual(session.stackEntries["nav"], root.map { [$0] })
        _ = try session.run([action("replace", "detail")])
        _ = try session.run([action("popToRoot")])
        XCTAssertEqual(session.stackEntries["nav"]?.first?.screen, "home")
        _ = try session.run([action("replace", "detail"), action("push", "detail"), action("popToRoot")])
        XCTAssertEqual(session.stackEntries["nav"]?.first?.screen, "home")
        session.show(spec, reset: true)
        XCTAssertEqual(session.stackChanges["nav"]?.direction, .reset)
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"])
        let wire = try XCTUnwrap(session.navigationSnapshot["stacks"] as? [String: [String: Any]])
        XCTAssertEqual(try Set(XCTUnwrap(wire["nav"]).keys), ["path", "depth"])
    }

    func testGestureGeometryCommitVelocityCancelAndSessionIsolation() throws {
        XCTAssertTrue(PrototypeStackSwipe.isAtEdge(start: 20, width: 300, rtl: false))
        XCTAssertFalse(PrototypeStackSwipe.isAtEdge(start: 21, width: 300, rtl: false))
        XCTAssertTrue(PrototypeStackSwipe.isAtEdge(start: 280, width: 300, rtl: true))
        XCTAssertFalse(PrototypeStackSwipe.isAtEdge(start: 279, width: 300, rtl: true))
        XCTAssertFalse(PrototypeStackSwipe.isAtEdge(start: -1, width: 300, rtl: false))
        XCTAssertFalse(PrototypeStackSwipe.isAtEdge(start: 301, width: 300, rtl: true))
        for rtl in [false, true] {
            let sign = rtl ? -1.0 : 1.0
            XCTAssertEqual(PrototypeStackSwipe.progress(translation: -sign * 10, width: 300, rtl: rtl), 0)
            XCTAssertEqual(PrototypeStackSwipe.progress(translation: sign * 400, width: 300, rtl: rtl), 1)
            XCTAssertEqual(PrototypeStackSwipe.progress(translation: sign * 75, width: 300, rtl: rtl), 0.25)
            XCTAssertEqual(PrototypeStackSwipe.progress(translation: sign * 75, width: 0, rtl: rtl), 0)
            XCTAssertTrue(PrototypeStackSwipe.commits(translation: sign * 151, predicted: 0, width: 300, rtl: rtl))
            XCTAssertTrue(PrototypeStackSwipe.commits(
                translation: sign * 30,
                predicted: sign * 180,
                width: 300,
                rtl: rtl
            ))
            XCTAssertFalse(PrototypeStackSwipe.commits(
                translation: sign * 150,
                predicted: sign * 150,
                width: 300,
                rtl: rtl
            ))
            var session = PrototypeSession()
            try session.show(JSONDecoder().decode(PrototypeSpec.self, from: spec()))
            let push = try JSONDecoder().decode(
                PrototypeAction.self,
                from: Data(#"{"type":"push","stack":"nav","screen":"home"}"#.utf8)
            )
            _ = session.run([push])
            let before = session.stacks
            let changes = session.stackChanges
            let sequence = session.lastSequence
            if PrototypeStackSwipe.commits(translation: sign * 30, predicted: sign * 40, width: 300, rtl: rtl) {
                _ = session.popTopmostStack()
            }
            XCTAssertEqual(session.stacks, before)
            XCTAssertEqual(session.stackChanges, changes)
            XCTAssertEqual(session.lastSequence, sequence)
        }
    }
}
