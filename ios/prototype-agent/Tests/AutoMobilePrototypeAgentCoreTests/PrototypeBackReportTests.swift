@testable import AutoMobilePrototypeAgentCore
import XCTest

/// ProtoViewer gives Back to the prototype while it can go back itself, and closes it only from the
/// root route (#19086).
final class PrototypeBackReportTests: XCTestCase {
    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }

    private let feed = """
    {"id":"b","window":{"placement":{"type":"fullscreen"}},"state":{"menu":false},
     "root":{"type":"column","children":[
      {"type":"stack","id":"nav","start":"feed","screens":{
       "feed":{"type":"text","text":"Feed"},
       "post":{"type":"text","text":"Post 42"}}},
      {"type":"drawer","edge":"start","openWhen":{"key":"menu","equals":true},
       "child":{"type":"text","text":"Menu"}}]}}
    """

    func testAPushedRouteHandlesBackUntilItIsPopped() throws {
        var session = PrototypeSession()
        XCTAssertFalse(session.handlesBack, "nothing shown")
        try session.show(spec(feed))
        XCTAssertFalse(session.handlesBack, "the root route closes the prototype")
        _ = try session.run([action(#"{"type":"push","stack":"nav","screen":"post"}"#)])
        XCTAssertTrue(session.handlesBack)
        _ = session.popTopmostStack()
        XCTAssertEqual(session.stacks["nav"]?.path, ["feed"])
        XCTAssertFalse(session.handlesBack)
    }

    func testAnOpenDrawerHandlesBackAtTheRootRoute() throws {
        var session = PrototypeSession()
        try session.show(spec(feed))
        _ = try session.run([action(#"{"type":"setState","key":"menu","value":true}"#)])
        XCTAssertTrue(session.handlesBack)
        _ = session.popTopmostStack()
        XCTAssertEqual(session.state["menu"], .bool(false))
        XCTAssertFalse(session.handlesBack)
    }

    func testTheReportFiresOnTheFirstValueAndOnEachChangeOnly() {
        var report = PrototypeBackReport()
        XCTAssertEqual(report.report(handlesBack: false), false)
        XCTAssertNil(report.report(handlesBack: false))
        XCTAssertEqual(report.report(handlesBack: true), true)
        XCTAssertNil(report.report(handlesBack: true))
        XCTAssertEqual(report.report(handlesBack: false), false)
    }
}
