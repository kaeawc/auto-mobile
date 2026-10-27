@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeAdaptiveTests: XCTestCase {
    func testNativeWidthModes() {
        XCTAssertEqual(PrototypeAdaptive.layout(kind: "listDetail", width: .compact), .stack)
        XCTAssertEqual(PrototypeAdaptive.layout(kind: "listDetail", width: .regular), .split)
        XCTAssertEqual(PrototypeAdaptive.layout(kind: "navigationSuite", width: .compact), .bottomBar)
        XCTAssertEqual(PrototypeAdaptive.layout(kind: "navigationSuite", width: .regular), .sidebar)
        XCTAssertEqual(PrototypeAdaptive.layout(kind: "supporting", width: .compact), .sheet)
        XCTAssertEqual(PrototypeAdaptive.layout(kind: "supporting", width: .regular), .inspector)
    }

    func testBackOnlyClearsACompactListSelection() {
        let state: [String: JSONValue] = ["selected": .string("row"), "other": .bool(true)]
        let back = PrototypeAdaptive.compactBack(
            kind: "listDetail",
            width: .compact,
            selectionKey: "selected",
            state: state
        )
        XCTAssertEqual(back?.0, "selected")
        XCTAssertEqual(back?.1, .string(""))
        XCTAssertEqual(state["other"], .bool(true))
        XCTAssertNil(PrototypeAdaptive.compactBack(
            kind: "listDetail",
            width: .regular,
            selectionKey: "selected",
            state: state
        ))
        XCTAssertNil(PrototypeAdaptive.compactBack(
            kind: "supporting",
            width: .compact,
            selectionKey: "selected",
            state: state
        ))
        XCTAssertNil(PrototypeAdaptive.compactBack(
            kind: "listDetail",
            width: .compact,
            selectionKey: "selected",
            state: ["selected": .string("")]
        ))
    }

    func testSessionSelectionAndInvalidWrites() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"adaptive","window":{"placement":{"type":"fullscreen"}},"state":{"selected":""},
        "root":{"type":"adaptive","kind":"listDetail","selectionKey":"selected","list":{"type":"text","text":"List"},"detail":{"type":"text","text":"Detail"}}}
        """#.utf8))
        var session = PrototypeSession()
        try session.show(spec)
        let events = session.choose(key: "selected", value: "row", then: [])
        XCTAssertEqual(session.state["selected"], .string("row"))
        XCTAssertEqual(events.last?.name, "change")
        let bad = try JSONDecoder().decode(
            PrototypeAction.self,
            from: Data(#"{"type":"setState","key":"selected","value":true}"#.utf8)
        )
        _ = session.run([bad])
        XCTAssertEqual(session.state["selected"], .string("row"))
        let back = try XCTUnwrap(PrototypeAdaptive.compactBack(
            kind: "listDetail",
            width: .compact,
            selectionKey: "selected",
            state: session.state
        ))
        _ = try session.choose(key: back.0, value: XCTUnwrap(back.1.stringValue), then: [])
        XCTAssertEqual(session.state["selected"], .string(""))
    }
}
