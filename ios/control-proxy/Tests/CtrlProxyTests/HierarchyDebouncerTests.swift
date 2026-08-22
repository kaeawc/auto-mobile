@testable import CtrlProxy
import XCTest

/// Simple reference wrapper for use in test closures to avoid Swift concurrency warnings.
private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) {
        self.value = value
    }
}

final class HierarchyDebouncerTests: XCTestCase {
    var fakeLocator: FakeElementLocator!
    var fakeTimer: FakeTimer!
    var debouncer: HierarchyDebouncer!

    override func setUp() {
        super.setUp()
        fakeLocator = FakeElementLocator()
        fakeTimer = FakeTimer(mode: .manual, initialTime: 0)
        debouncer = HierarchyDebouncer(
            elementLocator: fakeLocator,
            timer: fakeTimer,
            pollIntervalMs: 10
        )
    }

    override func tearDown() {
        debouncer.stop()
        fakeTimer.reset()
        super.tearDown()
    }

    // MARK: - Polling Resilience Tests

    func testContinuesPollingAfterExtractionError() {
        // Configure locator to throw on first calls
        let testError = NSError(domain: "test", code: 1, userInfo: nil)
        fakeLocator.setShouldThrow(testError)

        let results = Box<[HierarchyResult]>([])
        debouncer.setOnResult { result in
            results.value.append(result)
        }

        debouncer.start()

        // Initial capture should fail (throws), but debouncer should still be running
        XCTAssertTrue(debouncer.isRunning)

        // Advance past the poll interval to trigger a poll cycle - still throwing
        fakeTimer.advance(by: 10)
        XCTAssertTrue(debouncer.isRunning, "Debouncer should keep running after extraction error")
        XCTAssertEqual(results.value.count, 0, "No results should be emitted during errors")

        // Now stop throwing and provide a hierarchy
        fakeLocator.setShouldThrow(nil)
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)

        // Advance past debounce window so broadcast is allowed
        fakeTimer.advance(by: HierarchyDebouncer.broadcastDebounceMs + 10)

        // Should have recovered and emitted a result
        XCTAssertTrue(debouncer.isRunning, "Debouncer should still be running after recovery")
        XCTAssertEqual(results.value.count, 1, "Should emit result after recovery from error")
    }

    func testStartCapturesInitialState() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)

        debouncer.start()

        XCTAssertTrue(debouncer.isRunning)
        let lastHierarchy = debouncer.getLastHierarchy()
        XCTAssertNotNil(lastHierarchy)
        XCTAssertEqual(lastHierarchy?.packageName, "com.test.app")
    }

    func testStartBroadcastsInitialState() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)

        let results = Box<[HierarchyResult]>([])
        debouncer.setOnResult { result in
            results.value.append(result)
        }

        debouncer.start()

        // Initial state should be broadcast immediately via onResult
        XCTAssertEqual(results.value.count, 1, "Initial state should be broadcast on start")
        if case let .changed(h, _, _) = results.value.first {
            XCTAssertEqual(h.packageName, "com.test.app")
        } else {
            XCTFail("Expected .changed result for initial broadcast")
        }
    }

    func testUpdatedPollIntervalControlsNextPoll() {
        let first = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "First",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        let second = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Second",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(first)
        let results = Box<[HierarchyResult]>([])
        debouncer.setOnResult { result in
            results.value.append(result)
        }

        debouncer.start()
        debouncer.setPollIntervalMs(50)
        fakeLocator.setHierarchy(second)
        fakeTimer.advance(by: 49)
        XCTAssertEqual(results.value.count, 1, "initial capture only before updated interval elapses")

        fakeTimer.advance(by: 1)

        XCTAssertEqual(results.value.count, 2, "updated interval should drive the next poll")
    }

    func testStopPreventsPolling() {
        debouncer.start()
        XCTAssertTrue(debouncer.isRunning)

        debouncer.stop()
        XCTAssertFalse(debouncer.isRunning)

        // Advancing timer should not trigger any polling
        let initialCount = fakeLocator.hierarchyRequestCount
        fakeTimer.advance(by: 100)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, initialCount)
    }

    func testUpdatePollIntervalWhileRunningChangesNextPollCadence() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)
        debouncer.start()
        let initialCount = fakeLocator.hierarchyRequestCount

        debouncer.updatePollIntervalMs(50)
        fakeTimer.advance(by: 49)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, initialCount)

        fakeTimer.advance(by: 1)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, initialCount + 1)
    }

    func testResetPollIntervalUsesDefaultCadenceForFuturePolls() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)
        debouncer.start()
        debouncer.updatePollIntervalMs(HierarchyDebouncer.defaultPollIntervalMs)
        let initialCount = fakeLocator.hierarchyRequestCount

        fakeTimer.advance(by: HierarchyDebouncer.defaultPollIntervalMs - 1)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, initialCount)

        fakeTimer.advance(by: 1)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, initialCount + 1)
    }

    func testExtractNowBlockingReturnsHierarchy() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)

        debouncer.start()
        let result = debouncer.extractNowBlocking(skipFlowEmit: true)

        XCTAssertNotNil(result)
        XCTAssertEqual(result?.packageName, "com.test.app")
    }

    func testDetectsStructuralChange() {
        let hierarchy1 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy1)

        let results = Box<[HierarchyResult]>([])
        debouncer.setOnResult { result in
            results.value.append(result)
        }

        debouncer.start()

        // Change hierarchy to include a new element (structural change)
        let hierarchy2 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "New Button",
                        className: "UIButton",
                        bounds: ElementBounds(left: 10, top: 10, right: 100, bottom: 50),
                        clickable: "true",
                        role: "button"
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy2)

        // Advance past debounce window
        fakeTimer.advance(by: HierarchyDebouncer.broadcastDebounceMs + 10)

        // 2 results: initial broadcast + structural change
        XCTAssertEqual(results.value.count, 2)
        if case let .changed(hierarchy, _, _) = results.value.last {
            XCTAssertEqual(hierarchy.packageName, "com.test.app")
        } else {
            XCTFail("Expected .changed result")
        }
    }

    func testResetClearsState() {
        let hierarchy = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy)

        debouncer.start()
        XCTAssertNotNil(debouncer.getLastHierarchy())

        debouncer.reset()
        XCTAssertNil(debouncer.getLastHierarchy())
    }

    // MARK: - Debounce Resilience Tests

    func testDebouncedChangeIsEventuallyBroadcast() {
        // This tests the fix for a bug where the last change in a rapid sequence
        // could be silently dropped: the hash was updated but the broadcast was
        // debounced, so subsequent polls saw no change and entered animation mode.

        let hierarchy1 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy1)

        let results = Box<[HierarchyResult]>([])
        debouncer.setOnResult { result in
            results.value.append(result)
        }

        debouncer.start()

        // First change - advance past debounce to broadcast
        let hierarchy2 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "Button A",
                        className: "UIButton",
                        bounds: ElementBounds(left: 10, top: 10, right: 100, bottom: 50),
                        clickable: "true",
                        role: "button"
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy2)
        fakeTimer.advance(by: HierarchyDebouncer.broadcastDebounceMs + 10)
        XCTAssertEqual(results.value.count, 2, "Initial broadcast + first change should be broadcast")

        // Second change immediately after - within debounce window
        // This simulates a permission dialog appearing right after a UI change
        let hierarchy3 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "Button A",
                        className: "UIButton",
                        bounds: ElementBounds(left: 10, top: 10, right: 100, bottom: 50),
                        clickable: "true",
                        role: "button"
                    ),
                    UIElementInfo(
                        text: "Permission Dialog",
                        className: "UIAlertController",
                        bounds: ElementBounds(left: 20, top: 300, right: 355, bottom: 500),
                        clickable: "true"
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        fakeLocator.setHierarchy(hierarchy3)

        // Advance just past poll interval but within debounce window (should detect but not broadcast yet)
        fakeTimer.advance(by: 10)
        XCTAssertEqual(results.value.count, 2, "Change within debounce window should not broadcast yet")

        // Now advance past the debounce window - the change MUST eventually be broadcast
        fakeTimer.advance(by: HierarchyDebouncer.broadcastDebounceMs + 10)
        XCTAssertEqual(results.value.count, 3, "Debounced change must eventually be broadcast")

        // Verify the broadcast contains the dialog
        if case let .changed(hierarchy, _, _) = results.value.last {
            let hasDialog = hierarchy.hierarchy?.node?.contains { $0.text == "Permission Dialog" } ?? false
            XCTAssertTrue(hasDialog, "Broadcast should contain the permission dialog")
        } else {
            XCTFail("Expected .changed result")
        }
    }

    func testReportsStructuralTransitionBeforeDebouncedBroadcast() {
        let initial = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(text: "A")
        )
        let changed = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(text: "B")
        )
        fakeLocator.setHierarchy(initial)
        let transitions = Box<[ViewHierarchy]>([])
        debouncer.setOnTransition { hierarchy in
            transitions.value.append(hierarchy)
        }

        debouncer.start()
        fakeLocator.setHierarchy(changed)
        fakeTimer.advance(by: 10)

        XCTAssertEqual(transitions.value.count, 1)
        XCTAssertEqual(transitions.value.first?.hierarchy?.text, "B")
    }

    // MARK: - Idle Backoff Tests (#5477)

    /// Helper: a distinct static hierarchy so the debouncer sees "no change".
    private func staticHierarchy(_ text: String) -> ViewHierarchy {
        ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: text,
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
    }

    /// A fresh debouncer whose base interval (200ms) exceeds the 100ms animation
    /// skip window, so backed-off polls are never mistaken for animation skips —
    /// matching the production base of 1000ms.
    private func makeBackoffDebouncer() -> HierarchyDebouncer {
        HierarchyDebouncer(elementLocator: fakeLocator, timer: fakeTimer, pollIntervalMs: 200)
    }

    /// On a static screen the poll interval must grow base -> 2x -> 4x and then
    /// hold at the cap. With base = 200ms the cap is 800ms, so polls land at
    /// t = 200, 600, 1400, 2200, ... (intervals 200, 400, 800, 800).
    func testBacksOffPollIntervalWhileIdle() {
        let debouncer = makeBackoffDebouncer()
        defer { debouncer.stop() }
        fakeLocator.setHierarchy(staticHierarchy("Idle"))
        debouncer.start() // captureInitialState => 1 request
        let base = fakeLocator.hierarchyRequestCount
        XCTAssertEqual(base, 1)

        // First poll at t=200 (base interval), then backs off to 400ms.
        fakeTimer.advance(by: 200)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, base + 1, "first poll fires at base interval (t=200)")

        // No poll for the next 200ms (next is 400ms out, at t=600).
        fakeTimer.advance(by: 200)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, base + 1, "interval doubled to 400ms after idle poll")

        // Second poll at t=600, then backs off to 800ms (the cap).
        fakeTimer.advance(by: 200)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, base + 2, "second poll at t=600 (200+400)")

        // No poll for the next 400ms (next is at t=1400).
        fakeTimer.advance(by: 400)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, base + 2, "interval grew to the 800ms cap")

        // Third poll at t=1400, cap holds at 800ms.
        fakeTimer.advance(by: 400)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, base + 3, "third poll at t=1400 (600+800)")

        // Cap holds: the next poll is a further 800ms out (t=2200), not more.
        fakeTimer.advance(by: 800)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, base + 4, "cap holds at 800ms, poll at t=2200")
    }

    /// A detected structural change resets the cadence back to the fast base
    /// interval, so the debouncer is immediately responsive after any change even
    /// if it had backed off while idle.
    func testResetsToFastIntervalOnStructuralChange() {
        let debouncer = makeBackoffDebouncer()
        defer { debouncer.stop() }
        fakeLocator.setHierarchy(staticHierarchy("Idle"))
        debouncer.start()
        let baseCount = fakeLocator.hierarchyRequestCount

        // Idle long enough to reach the 800ms cap: polls at t=200, 600, 1400. Each
        // poll self-reschedules the next one, so advance in per-interval steps.
        fakeTimer.advance(by: 200) // t=200 poll, backs off to 400ms
        fakeTimer.advance(by: 400) // t=600 poll, backs off to 800ms
        fakeTimer.advance(by: 800) // t=1400 poll, holds at 800ms cap
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, baseCount + 3, "backed off to the cap while idle")

        // A structural change arrives; the next poll (at the backed-off cadence,
        // t=2200) detects it and resets the interval to the fast base.
        fakeLocator.setHierarchy(staticHierarchy("Changed"))
        fakeTimer.advance(by: 800) // t=2200: change detected, cadence reset to base (200ms)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, baseCount + 4, "change detected at backed-off cadence")

        // Now polling is fast again: the very next poll fires only 200ms later.
        fakeTimer.advance(by: 200)
        XCTAssertEqual(
            fakeLocator.hierarchyRequestCount,
            baseCount + 5,
            "cadence reset to the fast base interval after the change"
        )
    }

    /// An explicit `extractNow` resets the backed-off cadence to the fast base
    /// interval, matching the "reset on explicit command" acceptance criterion.
    func testExtractNowResetsBackoff() {
        let debouncer = makeBackoffDebouncer()
        defer { debouncer.stop() }
        fakeLocator.setHierarchy(staticHierarchy("Idle"))
        debouncer.start()
        let baseCount = fakeLocator.hierarchyRequestCount

        // Reach the 800ms cap while idle: polls at t=200, 600, 1400 (stepped so each
        // self-rescheduled poll fires).
        fakeTimer.advance(by: 200)
        fakeTimer.advance(by: 400)
        fakeTimer.advance(by: 800)
        XCTAssertEqual(fakeLocator.hierarchyRequestCount, baseCount + 3)

        // Explicit extraction (one immediate request) also resets the cadence and
        // reschedules the next poll at the fast base interval (t=1600), cancelling
        // the pending backed-off poll that was due at t=2200.
        debouncer.extractNow()
        let afterExtract = fakeLocator.hierarchyRequestCount
        XCTAssertEqual(afterExtract, baseCount + 4, "extractNow performs one immediate extraction")

        // The rescheduled poll fires 200ms later (t=1600), not at the old t=2200.
        fakeTimer.advance(by: 200)
        XCTAssertEqual(
            fakeLocator.hierarchyRequestCount,
            afterExtract + 1,
            "reset poll fires at the base interval (t=1600)"
        )

        // The old backed-off poll (t=2200) was cancelled: advancing to t=2200 fires
        // no extra poll beyond the rebuilt cadence (next is at t=2400).
        fakeTimer.advance(by: 600) // t=2200
        XCTAssertEqual(
            fakeLocator.hierarchyRequestCount,
            afterExtract + 1,
            "the cancelled t=2200 poll does not fire"
        )
    }

    // MARK: - StructuralHasher Tests

    func testHashChangesWhenAlertNodesAdded() {
        let hierarchyWithoutAlert = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "XCUIApplication",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "Hello",
                        className: "UILabel",
                        bounds: ElementBounds(left: 10, top: 10, right: 200, bottom: 30),
                        role: "text"
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hierarchyWithAlert = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "XCUIApplication",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "Hello",
                        className: "UILabel",
                        bounds: ElementBounds(left: 10, top: 10, right: 200, bottom: 30),
                        role: "text"
                    ),
                    UIElementInfo(
                        text: "\u{201c}App\u{201d} Would Like to Send You Notifications",
                        className: "UIAlertController",
                        bounds: ElementBounds(left: 20, top: 300, right: 355, bottom: 500),
                        node: [
                            UIElementInfo(
                                text: "Allow",
                                className: "UIButton",
                                bounds: ElementBounds(left: 20, top: 450, right: 180, bottom: 490),
                                clickable: "true",
                                role: "button"
                            ),
                            UIElementInfo(
                                text: "Don\u{2019}t Allow",
                                className: "UIButton",
                                bounds: ElementBounds(left: 190, top: 450, right: 355, bottom: 490),
                                clickable: "true",
                                role: "button"
                            ),
                        ]
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hashWithout = StructuralHasher.computeHash(hierarchyWithoutAlert)
        let hashWith = StructuralHasher.computeHash(hierarchyWithAlert)

        XCTAssertNotEqual(hashWithout, hashWith, "Hash should change when alert nodes are added to hierarchy")
    }

    func testHashUnchangedForBoundsOnlyDifference() {
        let hierarchy1 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "Hello",
                        className: "UILabel",
                        bounds: ElementBounds(left: 10, top: 10, right: 200, bottom: 30)
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        // Same structure, different bounds (simulating animation)
        let hierarchy2 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        text: "Hello",
                        className: "UILabel",
                        bounds: ElementBounds(left: 15, top: 15, right: 205, bottom: 35)
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hash1 = StructuralHasher.computeHash(hierarchy1)
        let hash2 = StructuralHasher.computeHash(hierarchy2)

        XCTAssertEqual(hash1, hash2, "Hash should be the same when only bounds differ (animation)")
    }

    func testHashChangesWhenContentDescChanges() {
        let hierarchy1 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        contentDesc: "Balance: $100",
                        className: "UILabel",
                        bounds: ElementBounds(left: 10, top: 10, right: 200, bottom: 30)
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hierarchy2 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812),
                node: [
                    UIElementInfo(
                        contentDesc: "Balance: $200",
                        className: "UILabel",
                        bounds: ElementBounds(left: 10, top: 10, right: 200, bottom: 30)
                    ),
                ]
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hash1 = StructuralHasher.computeHash(hierarchy1)
        let hash2 = StructuralHasher.computeHash(hierarchy2)

        XCTAssertNotEqual(hash1, hash2, "Hash should change when contentDesc changes")
    }

    func testHashChangesWhenClickableStateChanges() {
        let hierarchy1 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Submit",
                className: "UIButton",
                bounds: ElementBounds(left: 10, top: 10, right: 100, bottom: 50),
                clickable: "true",
                enabled: "true"
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hierarchy2 = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Submit",
                className: "UIButton",
                bounds: ElementBounds(left: 10, top: 10, right: 100, bottom: 50),
                clickable: "false",
                enabled: "false"
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hash1 = StructuralHasher.computeHash(hierarchy1)
        let hash2 = StructuralHasher.computeHash(hierarchy2)

        XCTAssertNotEqual(hash1, hash2, "Hash should change when clickable/enabled state changes")
    }

    func testHashChangesWhenCheckedStateChanges() {
        let hierarchyUnchecked = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Wi-Fi",
                className: "UISwitch",
                bounds: ElementBounds(left: 280, top: 100, right: 340, bottom: 130),
                checkable: "true",
                checked: nil
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hierarchyChecked = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Wi-Fi",
                className: "UISwitch",
                bounds: ElementBounds(left: 280, top: 100, right: 340, bottom: 130),
                checkable: "true",
                checked: "true"
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )

        let hashUnchecked = StructuralHasher.computeHash(hierarchyUnchecked)
        let hashChecked = StructuralHasher.computeHash(hierarchyChecked)

        XCTAssertNotEqual(hashUnchecked, hashChecked, "Hash should change when checked state changes")
    }
}
