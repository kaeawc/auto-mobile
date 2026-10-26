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

    func testEnumMatchesSharedContract() throws {
        let (_, validator) = try PrototypeContractValidator.inspect(data: spec())
        let values = validator.definitions["stackTransition"]?.objectFields?["values"]
        XCTAssertEqual(values, .array(PrototypeStackTransition.allCases.map { .string($0.rawValue) }))
    }

    func testValuesDecodeOnStacksAndActions() throws {
        for transition in PrototypeStackTransition.allCases {
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
                ["prototype_stack_transitions_v1", "prototype_stack_v1"]
            )
        }
    }

    func testInvalidEnumsObjectsAndPopOverridesAreRejected() {
        for bad in [#""scale""#, #""sharedAxisX""#, #"{"type":"fade"}"#, "null"] {
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
                for specMotion in [nil, "none", "platform"] as [String?] {
                    for reduced in [false, true] {
                        for direction in [PrototypeStackChange.Direction.push, .pop, .replace, .reset] {
                            let chosen = override ?? declared
                            let expected: PrototypeStackAnimation = specMotion == "none" || chosen == .none ||
                                direction == .reset
                                ? .none : reduced || chosen == .fade || (chosen == .platform && direction == .replace) ?
                                .fade : .slide
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
