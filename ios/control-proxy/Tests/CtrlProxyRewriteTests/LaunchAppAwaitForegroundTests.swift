@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class LaunchAppAwaitForegroundTests: XCTestCase {
    func testHierarchyCommandCompletesWhileLaunchAwaitsForeground() async throws {
        let clock = KeyboardTestClock(manual: true)
        let probe = ScriptedAppStateProbe(states: [1])
        let locator = RewriteFakeElementLocator(appStateClock: clock, appStateProbe: probe)
        locator.appState = .notRunning
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(), perf: PerfProvider()
        )
        let launch = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(#"{"type":"request_launch_app","bundleId":"com.example.launched","requestId":"launch"}"#.utf8)
        )
        var launchFinished = false
        let task = Task { @MainActor in
            let response = await handler.handle(launch)
            launchFinished = true
            return response
        }

        await clock.waitUntilSleeping()
        let hierarchyRequest = try JSONDecoder().decode(
            WebSocketRequest.self, from: Data(#"{"type":"request_hierarchy","requestId":"read"}"#.utf8)
        )
        let hierarchyPayload = await handler.handle(hierarchyRequest)
        let hierarchy = try XCTUnwrap(hierarchyPayload as? HierarchyUpdateResponse)
        XCTAssertEqual(hierarchy.requestId, "read")
        XCTAssertNil(hierarchy.error)
        XCTAssertEqual(hierarchy.data?.packageName, locator.hierarchy.packageName)
        XCTAssertEqual(locator.filteringRequests, [false])
        XCTAssertFalse(launchFinished)
        XCTAssertEqual(probe.bundleIds, ["com.example.launched"])

        probe.states = [4]
        clock.release()
        let payload = await task.value
        let response = try XCTUnwrap(payload as? WebSocketResponse)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.requestId, "launch")
        XCTAssertTrue(launchFinished)
        XCTAssertEqual(probe.bundleIds, ["com.example.launched", "com.example.launched"])
    }
}
