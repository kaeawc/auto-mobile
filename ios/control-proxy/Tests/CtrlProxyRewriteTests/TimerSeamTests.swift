@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

/// Behavioral tests for the Phase-4A time seams (`ProxyTimer` / `TimeProvider`) and
/// their fakes. These are internal seams with no wire contract, so they are verified
/// against their documented semantics rather than differentially against the reference.
/// The fakes are genuinely `Sendable` (`OSAllocatedUnfairLock`), so callbacks capture a
/// lock-guarded counter rather than a plain `var`.
final class TimerSeamTests: XCTestCase {
    // MARK: - FakeTimeProvider

    func testFakeTimeProviderControllableTime() {
        let provider = FakeTimeProvider(initialTime: 100)
        XCTAssertEqual(provider.currentTimeMillis(), 100)
        provider.advance(by: 50)
        XCTAssertEqual(provider.currentTimeMillis(), 150)
        provider.setTime(999)
        XCTAssertEqual(provider.currentTimeMillis(), 999)
        provider.reset()
        XCTAssertEqual(provider.currentTimeMillis(), 0)
    }

    // MARK: - FakeTimer: instant mode

    func testInstantModeWaitAdvancesTimeImmediately() async {
        let timer = FakeTimer(mode: .instant, initialTime: 1000)
        await timer.wait(milliseconds: 250)
        XCTAssertEqual(timer.now(), 1250)
    }

    func testInstantModeScheduleFiresImmediately() {
        let timer = FakeTimer(mode: .instant)
        let fired = OSAllocatedUnfairLock<Int>(initialState: 0)
        timer.schedule(after: 100) { fired.withLock { $0 += 1 } }
        XCTAssertEqual(fired.withLock { $0 }, 1, "instant mode fires the callback synchronously")
        XCTAssertEqual(timer.pendingCallbackCount, 0)
        XCTAssertEqual(timer.now(), 100)
    }

    // MARK: - FakeTimer: manual mode

    func testManualModeScheduleFiresAtTargetTime() {
        let timer = FakeTimer(mode: .manual)
        let fired = OSAllocatedUnfairLock<Int>(initialState: 0)
        timer.schedule(after: 100) { fired.withLock { $0 += 1 } }
        XCTAssertEqual(timer.pendingCallbackCount, 1)
        XCTAssertEqual(fired.withLock { $0 }, 0, "callback must not fire before advance")

        timer.advance(by: 50)
        XCTAssertEqual(fired.withLock { $0 }, 0, "not yet at target time")
        XCTAssertEqual(timer.pendingCallbackCount, 1)

        timer.advance(by: 50)
        XCTAssertEqual(fired.withLock { $0 }, 1, "callback fires once time reaches the target")
        XCTAssertEqual(timer.pendingCallbackCount, 0)
    }

    func testManualModeAdvanceFiresDueCallbacksInTimeOrder() {
        let timer = FakeTimer(mode: .manual)
        let order = OSAllocatedUnfairLock<[Int]>(initialState: [])
        timer.schedule(after: 300) { order.withLock { $0.append(300) } }
        timer.schedule(after: 100) { order.withLock { $0.append(100) } }
        timer.schedule(after: 200) { order.withLock { $0.append(200) } }
        XCTAssertEqual(timer.pendingCallbackCount, 3)

        timer.advance(by: 250) // fires 100 then 200; 300 remains pending
        XCTAssertEqual(order.withLock { $0 }, [100, 200])
        XCTAssertEqual(timer.pendingCallbackCount, 1)

        timer.advance(by: 100) // now at 350; fires 300
        XCTAssertEqual(order.withLock { $0 }, [100, 200, 300])
        XCTAssertEqual(timer.pendingCallbackCount, 0)
    }

    func testManualModeWaiterResumesOnAdvance() async {
        let timer = FakeTimer(mode: .manual)
        let done = XCTestExpectation(description: "waiter resumed")
        Task {
            await timer.wait(milliseconds: 50)
            done.fulfill()
        }

        // The child task registers its continuation on first execution; yield until it does.
        var spins = 0
        while timer.pendingWaiterCount == 0, spins < 10_000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertEqual(timer.pendingWaiterCount, 1, "waiter should be registered before advance")

        timer.advance(by: 50)
        await fulfillment(of: [done], timeout: 1.0)
        XCTAssertEqual(timer.pendingWaiterCount, 0)
        XCTAssertEqual(timer.now(), 50)
    }

    // MARK: - Production seams (sanity)

    func testSystemProvidersReturnPositiveEpochTime() {
        XCTAssertGreaterThan(SystemTimer().now(), 0)
        XCTAssertGreaterThan(SystemTimeProvider().currentTimeMillis(), 0)
    }
}
