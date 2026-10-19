@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class CtrlProxySdkHierarchyRefreshTests: XCTestCase {
    func testSdkEventRefreshUsesNewestCommandCapture() async throws {
        let initial = ViewHierarchy(
            updatedAt: 10, packageName: "com.test.app", hierarchy: UIElementInfo(text: "Discover")
        )
        let command = ViewHierarchy(
            updatedAt: 20, packageName: "com.test.app", hierarchy: UIElementInfo(text: "Heavy Computation")
        )
        let perf = FakePerfTracking(flushResult: nil)
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: FakeElementLocator(hierarchy: initial),
            perf: perf, timer: FakeProxyTimer(mode: .manual)
        )
        debouncer.start()
        let cache = SdkHierarchyCache()
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(hierarchy: command),
            gesturePerformer: FakeGesturePerformer(), perf: perf,
            sdkHierarchyCache: cache, hierarchyDebouncer: debouncer
        )
        let request = try JSONDecoder().decode(RequestHierarchy.self, from: Data("{}".utf8))
        let response = try await handler.handleRequestHierarchy(request, startTime: Date())
        XCTAssertEqual(response.data?.updatedAt, 20)

        let payload = Data("""
        {"hierarchy":{"timestamp":30,"bundleId":"com.test.app","screenScale":3,
        "screenWidth":375,"screenHeight":812,"safeAreaInsets":{"top":20,"right":0,"bottom":10,"left":0}}}
        """.utf8)
        let batch = try JSONSerialization.data(withJSONObject: [
            "events": [["eventType": "view_hierarchy", "payload": payload.base64EncodedString()]],
        ])
        var refreshes: [ViewHierarchy] = []
        // Drive the production SDK decoder and the exact selection used by the coordinator's
        // refresh publisher synchronously on the main actor, without a server or actor-hop task.
        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache) {
            if let refresh = CtrlProxy.sdkHierarchyRefresh(hierarchyDebouncer: debouncer, commandHandler: handler) {
                refreshes.append(refresh)
            }
        }

        XCTAssertEqual(refreshes.count, 1)
        let refreshed = try XCTUnwrap(refreshes.first)
        XCTAssertEqual(refreshed.updatedAt, 20)
        XCTAssertEqual(refreshed.hierarchy?.text, "Heavy Computation")
        XCTAssertEqual(refreshed.insets.source, "ios-sdk-safe-area")
        XCTAssertEqual(refreshed.systemInsets?.top, 20)
        XCTAssertEqual(debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertNil(debouncer.getLastHierarchy()?.systemInsets, "SDK enrichment must not enter the raw cache")
    }

    func testSdkRefreshWithoutCaptureReturnsNil() {
        let locator = FakeElementLocator()
        let perf = FakePerfTracking(flushResult: nil)
        let debouncer = HierarchyDebouncer(
            hierarchyExtractor: locator, perf: perf, timer: FakeProxyTimer(mode: .manual)
        )
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: FakeGesturePerformer(), perf: perf
        )
        XCTAssertNil(CtrlProxy.sdkHierarchyRefresh(hierarchyDebouncer: debouncer, commandHandler: handler))
        XCTAssertTrue(locator.filteringRequests.isEmpty)
    }

    func testUndecodableSdkHierarchyEventLeavesCacheAndCallbackUntouched() throws {
        let cache = SdkHierarchyCache()
        // Missing required hierarchy fields: wire drift must not publish a refresh.
        let payload = Data(#"{"hierarchy":{"unexpected":true}}"#.utf8)
        let batch = try JSONSerialization.data(withJSONObject: [
            "events": [["eventType": "view_hierarchy", "payload": payload.base64EncodedString()]],
        ])
        var updates = 0
        var warnings: [String] = []
        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache, onHierarchyUpdated: { updates += 1 }, warn: { warnings.append($0) })
        XCTAssertEqual(updates, 0)
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings.first?.contains("hierarchy event undecodable") == true)
    }

    func testMalformedEnvelopeWarnsInsteadOfSilentlyDropping() {
        let cache = SdkHierarchyCache()
        var warnings: [String] = []
        // Mentions the event type so the fast path proceeds, but "events" is the wrong shape.
        let batch = Data(#"{"events":"view_hierarchy"}"#.utf8)
        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache, warn: { warnings.append($0) })
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings.first?.contains("envelope undecodable") == true)
    }

    func testBadEnvelopeEntryDoesNotHideLaterValidEvent() throws {
        let cache = SdkHierarchyCache()
        let payload = Data("""
        {"hierarchy":{"timestamp":30,"bundleId":"com.test.app","screenScale":3,
        "screenWidth":375,"screenHeight":812,"safeAreaInsets":{"top":20,"right":0,"bottom":10,"left":0}}}
        """.utf8)
        let batch = try JSONSerialization.data(withJSONObject: [
            "events": [
                ["eventType": "view_hierarchy", "payload": "not base64!"],
                ["eventType": "view_hierarchy", "payload": payload.base64EncodedString()],
            ],
        ])
        var updates = 0
        var warnings: [String] = []
        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache, onHierarchyUpdated: { updates += 1 }, warn: { warnings.append($0) })
        XCTAssertEqual(updates, 1)
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings.first?.contains("entry undecodable") == true)
    }
}
