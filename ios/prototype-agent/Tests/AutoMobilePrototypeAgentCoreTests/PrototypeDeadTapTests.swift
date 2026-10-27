@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeDeadTapTests: XCTestCase {
    private func spec(
        deadTaps: String = "true",
        root: String = #"{"type":"text","text":"hello"}"#
    )
        throws -> PrototypeSpec
    {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"dead","window":{"placement":{"type":"fullscreen"},"deadTaps":\(deadTaps)},
         "state":{"count":1},"root":\(root)}
        """.utf8))
    }

    func testRootPayloadAndSequenceContinuity() throws {
        var session = PrototypeSession()
        try session.show(spec())
        let event = try XCTUnwrap(session.deadTap(x: 12.34, y: 56.78).first)
        XCTAssertEqual(event.wireKind, "emit")
        XCTAssertEqual(event.name, "prototype_dead_tap")
        XCTAssertEqual(event.payload, .object([
            "stack": .null, "screen": .null, "x": .number(12.3), "y": .number(56.8),
        ]))
        XCTAssertEqual(event.state, ["count": .number(1)])
        XCTAssertEqual(event.pages, session.pages)
        XCTAssertEqual(event.stacks, session.stacks)
        XCTAssertEqual(event.sequence, 1)
        XCTAssertEqual(session.deadTap(x: 0, y: 0).first?.sequence, 2)
        XCTAssertEqual(session.dismiss(reason: .user).first?.sequence, 3)
        XCTAssertEqual(session.deadTap(x: 0, y: 0), [])
    }

    func testOffAndInactiveDoNotAllocateSequences() throws {
        var session = PrototypeSession()
        XCTAssertEqual(session.deadTap(x: 1, y: 2), [])
        for flag in ["false", "null"] {
            try session.show(spec(deadTaps: flag))
            XCTAssertEqual(session.deadTap(x: 1, y: 2), [])
            XCTAssertEqual(session.lastSequence, 0)
        }
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(
            #"{"id":"off","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Off"}}"#.utf8
        )))
        XCTAssertEqual(session.deadTap(x: 1, y: 2), [])
        XCTAssertEqual(session.lastSequence, 0)
        let absent = Data(#"{"placement":{"type":"fullscreen"}}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(WindowSpec.self, from: absent).deadTaps)
    }

    func testDeepestStackAndLexicographicTie() throws {
        let stackA =
            #"{"type":"stack","id":"a","start":"home","screens":{"home":{"type":"text","text":"A"},"next":{"type":"text","text":"Next"}}}"#
        let stackZ = stackA.replacingOccurrences(of: #""id":"a""#, with: #""id":"z""#)
        var session = PrototypeSession()
        try session.show(spec(root: stackZ))
        XCTAssertEqual(session.deadTap(x: 0, y: 0).first?.payload.objectFields?["stack"], .string("z"))
        try session.show(spec(root: """
        {"type":"column","children":[\(stackZ),\(stackA)]}
        """), reset: true)
        XCTAssertEqual(session.deadTap(x: 0, y: 0).first?.payload.objectFields?["stack"], .string("a"))
        let push = try JSONDecoder().decode(PrototypeAction.self, from: Data(
            #"{"type":"push","stack":"z","screen":"next"}"#.utf8
        ))
        _ = session.run([push])
        let event = try XCTUnwrap(session.deadTap(x: 0, y: 0).first)
        XCTAssertEqual(event.payload.objectFields?["stack"], .string("z"))
        XCTAssertEqual(event.payload.objectFields?["screen"], .string("next"))
        XCTAssertEqual(event.stacks["z"]?.path, ["home", "next"])
    }

    func testTrackerRejectsConsumedMovedCancelledAndMultipleTouches() {
        var tracker = PrototypeDeadTapTracker()
        tracker.begin(x: 10, y: 20)
        tracker.move(x: 12, y: 21)
        XCTAssertTrue(tracker.finish())
        XCTAssertFalse(tracker.finish())
        tracker.begin(x: 0, y: 0)
        tracker.consume()
        XCTAssertFalse(tracker.finish())
        tracker.begin(x: 0, y: 0)
        tracker.move(x: 10, y: 0)
        tracker.move(x: 0, y: 0)
        XCTAssertFalse(tracker.finish())
        tracker.begin(x: 0, y: 0)
        tracker.cancel()
        XCTAssertFalse(tracker.finish())
        tracker.begin(x: 0, y: 0)
        tracker.begin(x: 1, y: 1)
        XCTAssertFalse(tracker.finish())
    }

    func testSharedWindowDeadTapFixtures() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/window-dead-taps.json")
        )
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: []))
        XCTAssertEqual(try JSONDecoder().decode(PrototypeSpec.self, from: data).window.deadTaps, true)
        let invalid = try PrototypeSpecFixtures.invalid("window-dead-taps-not-boolean")
        XCTAssertThrowsError(try invalid.decode())
        XCTAssertThrowsError(
            try PrototypeSpecStrictValidator
                .validate(data: JSONEncoder().encode(invalid.spec))
        ) { error in
            guard case let PrototypeLoadError.invalidSpec(path, _) = error else {
                return XCTFail("Expected invalid window.deadTaps, got \(error)")
            }
            XCTAssertEqual(path, invalid.expectedPath)
        }
    }

    func testNoStrictGateAndReservedEmit() throws {
        let data = try JSONEncoder().encode(JSONValue.object([
            "window": .object(["deadTaps": .bool(true)]),
        ]))
        let fields = try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectFields)
        XCTAssertEqual(PrototypeStrictCapabilities.required(fields), [])
        // A host preflight capability like window.chrome minus the agent gate: embedded hosts just ignore it.
        XCTAssertEqual(PrototypeStrictCapabilities.required(fields, includeAgentGates: true), [])
        let reserved =
            Data(
                #"{"id":"dead","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Go","onTap":[{"type":"emit","name":"prototype_dead_tap"}]}}"#
                    .utf8
            )
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: reserved)) { error in
            guard case let PrototypeLoadError.invalidSpec(path, message) = error else {
                return XCTFail("Expected reserved emit rejection, got \(error)")
            }
            XCTAssertEqual(path, "root.onTap[0].name")
            XCTAssertTrue(message.contains("reserved"))
        }
    }
}
