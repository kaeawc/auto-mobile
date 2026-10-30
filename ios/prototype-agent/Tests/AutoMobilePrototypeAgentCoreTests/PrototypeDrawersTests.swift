@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeDrawersTests: XCTestCase {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    override static func setUp() {
        super.setUp()
        // Decode the generated contract once outside per-test timing.
        _ = try? PrototypeSpecStrictValidator.validate(data: Data("{}".utf8))
    }

    private func assertInvalidFixture(_ name: String) throws {
        struct Fixture: Decodable {
            let spec: JSONValue
            let expectedPath: String
            let expectedMessage: String
        }
        let fixture = try JSONDecoder().decode(
            Fixture.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name).json"))
        )
        let data = try JSONEncoder().encode(fixture.spec)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data)) { error in
            XCTAssertEqual(
                error as? PrototypeLoadError,
                .invalidSpec(path: fixture.expectedPath, message: fixture.expectedMessage),
                name
            )
        }
    }

    func testTooltipDrawerBadEdge() throws { try assertInvalidFixture("tooltip-drawer-bad-edge") }
    func testTooltipDrawerEqualsType() throws { try assertInvalidFixture("tooltip-drawer-equals-type") }
    func testTooltipDrawerMissingChild() throws { try assertInvalidFixture("tooltip-drawer-missing-child") }
    func testTooltipDrawerMissingEdge() throws { try assertInvalidFixture("tooltip-drawer-missing-edge") }
    func testTooltipDrawerStateType() throws { try assertInvalidFixture("tooltip-drawer-state-type") }
    func testTooltipDrawerUnknownField() throws { try assertInvalidFixture("tooltip-drawer-unknown-field") }
    func testTooltipDrawerWriteStateType() throws { try assertInvalidFixture("tooltip-drawer-write-state-type") }

    private static let keyedRepeatInDrawer = """
    {"id":"keyed-drawer","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
     "data":{"groups":[{"id":"g1","name":"Garden club"},{"id":"g2","name":"Book swap"}]},
     "root":{"type":"column","children":[
      {"type":"text","text":"Home"},
      {"type":"drawer","edge":"start","openWhen":{"key":"open","equals":true},
       "child":{"type":"column","repeat":{"items":{"path":"/groups"},"as":"group","key":"id"},
        "children":[{"type":"text","text":"{group.name}"}]}}]}}
    """

    /// #15815: expansion stamps `_repeatKey` on keyed rows; the post-expansion drawer check must not refuse it.
    func testKeyedRepeatInsideDrawerLoads() throws {
        let data = Data(Self.keyedRepeatInDrawer.utf8)
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data))
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        XCTAssertNoThrow(try PrototypeEmbeddedSpec.load(data: data))
        let rows = spec.root.children?.last?.child?.children ?? []
        XCTAssertEqual(rows.compactMap(\.repeatKey), ["g1", "g2"])
    }

    /// Only the expansion-added key is ignored: an authored `_repeatKey` is still an unknown property.
    func testAuthoredRepeatKeyInsideDrawerIsStillRefused() {
        let authored = Data("""
        {"id":"authored","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
         "root":{"type":"column","children":[
          {"type":"drawer","edge":"start","openWhen":{"key":"open","equals":true},
           "child":{"type":"text","text":"Panel","_repeatKey":"x"}}]}}
        """.utf8)
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: authored)) { error in
            guard case let .invalidSpec(path, message)? = error as? PrototypeLoadError else {
                return XCTFail("unexpected error \(error)")
            }
            XCTAssertTrue(path.hasSuffix("._repeatKey"), path)
            XCTAssertEqual(message, "Unknown property")
        }
    }

    func testWithoutRowKeysStripsNestedRowKeysOnly() {
        let value: JSONValue = .object([
            "type": .string("column"),
            PrototypeRepeat.rowKeyField: .string("a"),
            "children": .array([.object(["type": .string("text"), PrototypeRepeat.rowKeyField: .string("b")])]),
        ])
        XCTAssertEqual(
            PrototypeRepeat.withoutRowKeys(value),
            .object(["type": .string("column"), "children": .array([.object(["type": .string("text")])])])
        )
    }

    func testBackClosesDrawerBeforePoppingStack() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"back","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
         "root":{"type":"column","children":[
          {"type":"stack","id":"nav","start":"home","screens":{
            "home":{"type":"text","text":"Home"},"detail":{"type":"text","text":"Detail"}}},
          {"type":"drawer","edge":"end","openWhen":{"key":"open","equals":true},
           "child":{"type":"text","text":"Panel"}}]}}
        """.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let push = try JSONDecoder().decode(PrototypeAction.self, from: Data("""
        {"type":"push","stack":"nav","screen":"detail"}
        """.utf8))
        _ = session.run([push])
        XCTAssertNil(session.stackPopTarget)
        XCTAssertEqual(session.popTopmostStack().map(\.name), ["change"])
        XCTAssertEqual(session.state["open"], .bool(false))
        XCTAssertEqual(session.stackPopTarget, "nav")
        _ = session.popTopmostStack()
        XCTAssertNil(session.stackPopTarget)
    }

    func testGeometryMirrorsEdgesAndRespectsSafeWindow() {
        let window = CGRect(x: 10, y: 20, width: 400, height: 600)
        XCTAssertEqual(
            PrototypeDrawers.frame(window: window, edge: "start", rightToLeft: false),
            CGRect(x: 10, y: 20, width: 320, height: 600)
        )
        XCTAssertEqual(
            PrototypeDrawers.frame(window: window, edge: "end", rightToLeft: false),
            CGRect(x: 90, y: 20, width: 320, height: 600)
        )
        XCTAssertEqual(
            PrototypeDrawers.frame(window: window, edge: "start", rightToLeft: true),
            PrototypeDrawers.frame(window: window, edge: "end", rightToLeft: false)
        )
        XCTAssertEqual(
            PrototypeDrawers.frame(window: window, edge: "end", rightToLeft: true),
            PrototypeDrawers.frame(window: window, edge: "start", rightToLeft: false)
        )
        XCTAssertEqual(
            PrototypeDrawers
                .frame(window: CGRect(x: 0, y: 0, width: 300, height: 500), edge: "start", rightToLeft: false).width,
            244
        )
    }

    func testSwipeUsesSheetSettleRuleAndMotionUsesStackPolicy() {
        XCTAssertFalse(PrototypeDrawers.dismisses(width: 320, translation: -159, edge: "start", rightToLeft: false))
        XCTAssertTrue(PrototypeDrawers.dismisses(width: 320, translation: -161, edge: "start", rightToLeft: false))
        XCTAssertFalse(PrototypeDrawers.dismisses(width: 320, translation: 200, edge: "start", rightToLeft: false))
        XCTAssertTrue(PrototypeDrawers.dismisses(width: 320, translation: 200, edge: "start", rightToLeft: true))
        XCTAssertFalse(PrototypeDrawers.dismisses(
            width: 320,
            translation: -200,
            edge: "start",
            rightToLeft: false,
            dismissOnSwipe: false
        ))
        XCTAssertEqual(PrototypeDrawers.animation(specMotion: nil, reduceMotion: false), .slide)
        XCTAssertEqual(PrototypeDrawers.animation(specMotion: nil, reduceMotion: true), .fade)
        XCTAssertEqual(PrototypeDrawers.animation(specMotion: "none", reduceMotion: true), .none)
        XCTAssertEqual(PrototypeDrawers.animation(specMotion: "none", reduceMotion: false), .none)
    }

    func testModalBlockingAndDismissal() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"drawer","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},
         "root":{"type":"drawer","testTag":"drawer","edge":"start","openWhen":{"key":"open","equals":true},
                 "child":{"type":"text","text":"Navigation"}}}
        """.utf8))
        var session = PrototypeSession()
        session.show(spec)
        XCTAssertTrue(spec.root.blocksPage(state: session.state, pages: [:]))
        XCTAssertEqual(spec.root.layerAccessibility(state: session.state, pages: [:]), .collapsed)
        XCTAssertEqual(spec.root.openModals(state: session.state, pages: [:]).map(\.type), ["drawer"])
        XCTAssertEqual(prototypeAccessibilityGrouping(type: "drawer", tappable: true), .contain)
        XCTAssertFalse(spec.root.drawsInPlace { _ in true })
        let close = try XCTUnwrap(spec.root.tapTarget(identifier: "drawer.close", state: session.state))
        XCTAssertEqual(session.activate(close)?.map(\.name), ["change"])
        XCTAssertEqual(session.state["open"], .bool(false))
        XCTAssertTrue(spec.root.openModals(state: session.state, pages: [:]).isEmpty)
    }

    func testCapabilitiesAreAdvertisedAndRequiredByBothPaths() throws {
        for (type, capability) in [("tooltip", "prototype_tooltip_v1"), ("drawer", "prototype_drawer_v1")] {
            let raw: JSONValue = .object(["root": .object(["type": .string(type)])])
            XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(capability))
            XCTAssertTrue(PrototypeStrictCapabilities.required(raw.objectFields ?? [:]).contains(capability))
            XCTAssertTrue(try PrototypeBundleCapabilities.required(JSONEncoder().encode(raw)).contains(capability))
        }
    }
}
