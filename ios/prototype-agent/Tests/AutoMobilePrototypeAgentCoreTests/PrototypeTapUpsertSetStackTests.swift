@testable import AutoMobilePrototypeAgentCore
import XCTest

/// A tap runs `upsertData` and `setStack` like the other data and stack actions (#16620).
final class PrototypeTapUpsertSetStackTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func actions(_ text: String) throws -> [PrototypeAction] {
        try JSONDecoder().decode([PrototypeAction].self, from: Data(text.utf8))
    }

    private func shown(_ text: String) throws -> PrototypeSession {
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: Data(text.utf8)))
        return session
    }

    private func upsert(_ row: String) throws -> [PrototypeAction] {
        try actions(#"[{"type":"upsertData","path":"/data/rows","key":"/id","value":{"value":\#(row)}}]"#)
    }

    private static let rows =
        #"{"id":"rows","window":{"placement":{"type":"fullscreen"}},"data":{"rows":[{"id":"a","n":1}]},"root":{"type":"text","text":"Rows"}}"#

    private static let stack =
        #"{"id":"nav","window":{"placement":{"type":"fullscreen"}},"root":{"type":"stack","id":"nav","start":"home","screens":{"home":{"type":"text","text":"Home"},"detail":{"type":"text","text":"Detail"},"third":{"type":"text","text":"Third"}}}}"#

    func testUpsertAppendsANewKeyAndReplacesAnExistingOneWithAChangeEvent() throws {
        var session = try shown(Self.rows)
        let first = try session.run(upsert(#"{"id":"b","n":2}"#))
        let events = try session.run(upsert(#"{"id":"a","n":3}"#))
        XCTAssertEqual(session.data?["rows"], try json(#"[{"id":"a","n":3},{"id":"b","n":2}]"#))
        XCTAssertEqual(first.count, 1)
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(event.name, "/data/rows")
        let write = try XCTUnwrap(PrototypeDataWriteEvent.decode(
            kind: event.wireKind, name: event.name, payload: event.payload
        ))
        XCTAssertEqual(write.op, .upsert)
        XCTAssertEqual(write.key, "/id")
        XCTAssertEqual(write.value, try json(#"{"id":"a","n":3}"#))
        XCTAssertEqual(write.revision, session.dataRevision)
    }

    func testUpsertOnAMissingArrayChangesAndEmitsNothing() throws {
        var session = try shown(Self.rows.replacingOccurrences(of: #""rows":[{"id":"a","n":1}]"#, with: #""other":1"#))
        XCTAssertTrue(try session.run(upsert(#"{"id":"b"}"#)).isEmpty)
        XCTAssertEqual(session.data, ["other": .number(1)])
    }

    func testSetStackReplacesTheWholePathAndReportsTheNewTop() throws {
        var session = try shown(Self.stack)
        let events = try session.run(actions(
            #"[{"type":"setStack","stack":"nav","path":[{"screen":"home"},{"screen":"third"},{"screen":"detail"}]}]"#
        ))
        XCTAssertEqual(session.stacks["nav"]?.path, ["home", "third", "detail"])
        let event = try XCTUnwrap(events.first)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(event.wireKind, "screen_changed")
        XCTAssertEqual(event.name, "nav")
        XCTAssertEqual(event.payload, .object(["screen": .string("detail"), "depth": .number(3)]))
    }

    func testSetStackWithAnUnknownScreenAnEmptyPathOrTheSamePathIsSilent() throws {
        var session = try shown(Self.stack)
        for path in [#"[{"screen":"home"},{"screen":"missing"}]"#, "[]", #"[{"screen":"home"}]"#] {
            XCTAssertTrue(try session.run(actions(#"[{"type":"setStack","stack":"nav","path":\#(path)}]"#)).isEmpty)
        }
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"])
    }
}
