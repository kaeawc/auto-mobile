@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeZoomModelNavigationTests: XCTestCase {
    func testKeyedStackWithoutZoomActionsKeepsComposedRenderer() throws {
        let node =
            try decodeNode(
                #"{"type":"stack","id":"nav","start":"home","screens":{"home":{"type":"text","text":"Home","sharedKey":"hero","onTap":[{"type":"push","stack":"nav","screen":"home","transition":"fade"}]}}}"#
            )
        XCTAssertFalse(PrototypeZoomNavigation.hasZoom(in: node, root: node))
        let idle =
            try decodeNode(
                #"{"type":"stack","id":"nav","start":"home","transition":"zoom","screens":{"home":{"type":"text","text":"Home","sharedKey":"hero"}}}"#
            )
        XCTAssertFalse(PrototypeZoomNavigation.hasZoom(in: idle, root: idle))
    }

    func testZoomOverrideInNestedCallbackOutsideStackSelectsNativeHost() throws {
        let root =
            try decodeNode(
                #"{"type":"column","children":[{"type":"text","text":"Open","onTap":[{"type":"request","url":"https://example.com","onSuccess":[{"type":"push","stack":"nav","screen":"home","transition":"zoom","source":"hero"}]}]},{"type":"stack","id":"nav","start":"home","screens":{"home":{"type":"text","text":"Home","sharedKey":"hero"}}}]}"#
            )
        let stack = try XCTUnwrap(root.children?.last)
        XCTAssertTrue(PrototypeZoomNavigation.hasZoom(in: stack, root: root))
    }

    func testNativePopWithComposedScreenAboveZoomUpdatesModel() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/stack-patterns-zoom.json")
        )
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: data))
        _ = try session.run([action(#"{"type":"push","stack":"nav","screen":"detail","source":"hero"}"#)])
        _ = try session.run([action(#"{"type":"push","stack":"nav","screen":"detail","transition":"fade"}"#)])
        let entries = try XCTUnwrap(session.stackEntries["nav"])
        XCTAssertEqual(PrototypeZoomNavigation.destinations(entries).count, 1)
        let count = PrototypeZoomNavigation.popCount(entries, keeping: [])
        XCTAssertEqual(count, 2)
        _ = try session.run((0 ..< count).map { _ in try action(#"{"type":"pop","stack":"nav"}"#) })
        XCTAssertEqual(session.stacks["nav"]?.path, ["home"])
        XCTAssertTrue(PrototypeZoomNavigation.destinations(session.stackEntries["nav"] ?? []).isEmpty)
    }

    func testNativePopReturnsToPreviousComposedSegment() {
        let home = PrototypeStackEntry(id: 1, screen: "home")
        let detail = PrototypeStackEntry(id: 2, screen: "detail", zoomSource: "hero")
        let step = PrototypeStackEntry(id: 3, screen: "step")
        let next = PrototypeStackEntry(id: 4, screen: "next", zoomSource: "next")
        let entries = [home, detail, step, next]
        XCTAssertEqual(PrototypeZoomNavigation.popCount(entries, keeping: [detail]), 1)
        XCTAssertEqual(PrototypeZoomNavigation.popCount(entries, keeping: []), 3)
        XCTAssertEqual(PrototypeZoomNavigation.popCount(entries, keeping: [next]), 0)
    }

    func testZoomReplacingRootResetsNativeOriginAndCannotPopRemovedRoot() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/stack-patterns-zoom.json")
        )
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: data))
        let removed = session.stackEntries["nav"]?.first
        _ = try session.run([action(#"{"type":"replace","stack":"nav","screen":"detail","source":"hero"}"#)])
        let entries = try XCTUnwrap(session.stackEntries["nav"])
        XCTAssertNotEqual(entries.first?.id, removed?.id)
        XCTAssertEqual(entries.first?.screen, "detail")
        XCTAssertTrue(PrototypeZoomNavigation.destinations(entries).isEmpty)
        XCTAssertEqual(PrototypeZoomNavigation.popCount(entries, keeping: []), 0)
    }

    func testOutsideStackSourceFailsAtActionPath() throws {
        let fixture = try PrototypeSpecFixtures.invalid("stack-patterns-zoom-outside-stack")
        XCTAssertThrowsError(
            try PrototypeSpecStrictValidator
                .validate(data: JSONEncoder().encode(fixture.spec))
        ) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                path: fixture.expectedPath,
                message: fixture.expectedMessage ?? ""
            ))
        }
    }

    private func decodeNode(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }
}
