@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeZoomNavigationTests: XCTestCase {
    func testDecisionTable() {
        for os in [17, 18, 26] {
            for transition in PrototypeStackTransition.allCases {
                for profile in [PrototypeMotionProfile.full, .reduced, .off] {
                    let expected: PrototypeZoomNavigation.Rendering
                    if profile == .off || transition == .none { expected = .instant }
                    else if profile == .reduced || transition == .fade { expected = .crossfade }
                    else { expected = os >= 18 && transition == .zoom ? .zoom : .push }
                    XCTAssertEqual(
                        PrototypeZoomNavigation.resolve(osMajor: os, profile: profile, transition: transition),
                        expected
                    )
                }
            }
        }
    }

    func testCapabilityOnlyOn18AndLater() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        for os in [17, 18, 26] {
            XCTAssertEqual(
                PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: os))
                    .contains("prototype_zoom_transition_v1"),
                os >= 18
            )
        }
    }

    func testMixedSegmentsKeepComposedScreensAndEntryIdentity() {
        let home = PrototypeStackEntry(id: 1, screen: "home")
        let filter = PrototypeStackEntry(id: 2, screen: "filter")
        let detail = PrototypeStackEntry(id: 3, screen: "detail", zoomSource: "hero")
        let step = PrototypeStackEntry(id: 4, screen: "step")
        let next = PrototypeStackEntry(id: 5, screen: "detail", zoomSource: "second")
        let entries = [home, filter, detail, step, next]
        XCTAssertEqual(PrototypeZoomNavigation.segment(entries, startingAt: home), [home, filter])
        XCTAssertEqual(PrototypeZoomNavigation.segment(entries, startingAt: detail), [detail, step])
        XCTAssertEqual(PrototypeZoomNavigation.segment(entries, startingAt: next), [next])
        XCTAssertEqual(PrototypeZoomNavigation.segment([next], startingAt: home), [home])
    }

    func testSourceBelongsToEntryAndSurvivesComposedPushPopAndShow() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/stack-patterns-zoom.json")
        )
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: data)
        var session = PrototypeSession()
        session.show(spec)
        _ = try session.run([action(#"{"type":"push","stack":"nav","screen":"detail","source":"hero"}"#)])
        let zoom = session.stackEntries["nav"]?.last
        XCTAssertEqual(zoom?.zoomSource, "hero")
        _ = try session.run([action(#"{"type":"push","stack":"nav","screen":"detail","transition":"fade"}"#)])
        XCTAssertNil(session.stackEntries["nav"]?.last?.zoomSource)
        _ = try session.run([action(#"{"type":"pop","stack":"nav"}"#)])
        XCTAssertEqual(session.stackEntries["nav"]?.last, zoom)
        session.show(spec)
        XCTAssertEqual(session.stackEntries["nav"]?.last, zoom)
    }

    func testReplaceCarriesSourceWithoutAddingDepth() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/stack-patterns-zoom.json")
        )
        var session = PrototypeSession()
        try session.show(JSONDecoder().decode(PrototypeSpec.self, from: data))
        _ = try session.run([action(#"{"type":"replace","stack":"nav","screen":"detail","source":"hero"}"#)])
        XCTAssertEqual(session.stackEntries["nav"]?.count, 1)
        XCTAssertEqual(session.stackEntries["nav"]?.last?.zoomSource, "hero")
    }

    private func action(_ json: String) throws -> PrototypeAction {
        try JSONDecoder().decode(PrototypeAction.self, from: Data(json.utf8))
    }
}
