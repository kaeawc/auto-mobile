@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class FrameContextBroadcastIdempotencyTests: XCTestCase {
    private func makeServer(frameContext: FrameContext, captured: ValueBox<Data>) -> WebSocketServer {
        WebSocketServer(
            commandHandler: FakeCommandHandling(handler: { _ in WebSocketResponse(type: "noop") }),
            perf: FakePerfTracking(flushResult: nil),
            frameContext: frameContext,
            broadcastSink: { captured.append($0) }
        )
    }

    private func tokens(_ captured: ValueBox<Data>) throws -> [String] {
        try captured.values.map { data in
            try XCTUnwrap(JSONDecoder().decode(HierarchyUpdateResponse.self, from: data).frameContext)
        }
    }

    func testIdenticalBroadcastsReuseGenerationAndToken() throws {
        let context = FrameContext()
        let captured = ValueBox<Data>()
        let server = makeServer(frameContext: context, captured: captured)

        server.broadcastHierarchyUpdate(ViewHierarchy(updatedAt: 1, packageName: "com.test.app"))
        server.broadcastHierarchyUpdate(ViewHierarchy(updatedAt: 2, packageName: "com.test.app"))

        let issued = try tokens(captured)
        XCTAssertEqual(issued.count, 2)
        XCTAssertEqual(issued[0], issued[1])
        XCTAssertTrue(issued[0].contains(":1:"), "the first recorded hierarchy starts generation one")
    }

    func testChangedHierarchyAdvancesGeneration() throws {
        let context = FrameContext()
        let captured = ValueBox<Data>()
        let server = makeServer(frameContext: context, captured: captured)

        server.broadcastHierarchyUpdate(ViewHierarchy(packageName: "com.test.a"))
        server.broadcastHierarchyUpdate(ViewHierarchy(packageName: "com.test.b"))

        let issued = try tokens(captured)
        XCTAssertEqual(issued.count, 2)
        XCTAssertNotEqual(issued[0], issued[1])
        XCTAssertTrue(issued[1].contains(":2:"))
    }

    func testContextForRemainsValidAfterIdenticalRebroadcast() throws {
        let context = FrameContext()
        let captured = ValueBox<Data>()
        let server = makeServer(frameContext: context, captured: captured)
        let hierarchy = ViewHierarchy(updatedAt: 1, packageName: "com.test.app")

        server.broadcastHierarchyUpdate(hierarchy)
        let observed = try XCTUnwrap(context.context(for: hierarchy))
        server.broadcastHierarchyUpdate(ViewHierarchy(updatedAt: 2, packageName: "com.test.app"))

        XCTAssertEqual(try tokens(captured), [observed, observed])
        XCTAssertEqual(
            try context.performIfCurrent(expected: observed, hierarchy: hierarchy) { "accepted" },
            "accepted"
        )
    }

    func testReturnToPreviousHierarchyStillAdvancesGeneration() throws {
        let context = FrameContext()
        let captured = ValueBox<Data>()
        let server = makeServer(frameContext: context, captured: captured)
        let a = ViewHierarchy(packageName: "com.test.a")
        let b = ViewHierarchy(packageName: "com.test.b")

        server.broadcastHierarchyUpdate(a)
        server.broadcastHierarchyUpdate(b)
        server.broadcastHierarchyUpdate(a)

        let issued = try tokens(captured)
        XCTAssertEqual(issued.count, 3)
        XCTAssertNotEqual(issued[0], issued[1])
        XCTAssertNotEqual(issued[1], issued[2])
        XCTAssertNotEqual(issued[0], issued[2])
        XCTAssertTrue(issued[2].contains(":3:"))
        XCTAssertThrowsError(try context.performIfCurrent(expected: issued[0], hierarchy: a) { "accepted" })
    }
}
