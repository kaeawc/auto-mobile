@testable import AudioLoopbackCore
import XCTest

final class TapSwapTests: XCTestCase {
    private struct BuildFailed: Error {}

    private final class Taps {
        var events: [String] = []
        var failNext = false
        var failAlways = false
        private var next = 0

        func build(_ clients: [UInt32: Int32]) throws -> Int {
            if failNext || failAlways {
                failNext = false
                events.append("fail \(clients.keys.sorted())")
                throw BuildFailed()
            }
            next += 1
            events.append("build \(next) \(clients.keys.sorted())")
            return next
        }

        func destroy(_ tap: Int) {
            events.append("destroy \(tap)")
        }
    }

    private func update(_ swap: inout TapSwap<UInt32, Int>, _ taps: Taps, _ clients: [UInt32: Int32]) -> String {
        switch swap.update(to: clients, build: taps.build, destroy: taps.destroy) {
        case .unchanged: "unchanged"
        case .rebuilt: "rebuilt"
        case let .failed(_, warn): warn ? "failed, warn" : "failed"
        case .backingOff: "backing off"
        }
    }

    func testANewTapIsBuiltBeforeTheOldOneIsTornDown() {
        var swap = TapSwap<UInt32, Int>()
        let taps = Taps()
        XCTAssertEqual(update(&swap, taps, [10: 101]), "rebuilt")
        XCTAssertEqual(update(&swap, taps, [10: 101, 11: 102]), "rebuilt")
        XCTAssertEqual(taps.events, ["build 1 [10]", "build 2 [10, 11]", "destroy 1"])
        XCTAssertEqual(swap.tap, 2)
        XCTAssertEqual(update(&swap, taps, [10: 101, 11: 102]), "unchanged")
        XCTAssertEqual(taps.events.count, 3)
    }

    func testAFailedRebuildKeepsTheRunningTapAndRetries() {
        var swap = TapSwap<UInt32, Int>()
        let taps = Taps()
        _ = update(&swap, taps, [10: 101, 11: 102])
        // Client 11 exits between enumeration and tap creation.
        taps.failNext = true
        XCTAssertEqual(update(&swap, taps, [10: 101, 12: 103]), "failed")
        XCTAssertEqual(swap.tap, 1, "the running tap keeps capturing")
        XCTAssertEqual(swap.clients, [10: 101, 11: 102])
        XCTAssertTrue(swap.retryPending)
        XCTAssertEqual(update(&swap, taps, [10: 101]), "rebuilt")
        XCTAssertFalse(swap.retryPending)
        XCTAssertEqual(taps.events, ["build 1 [10, 11]", "fail [10, 12]", "build 2 [10]", "destroy 1"])
    }

    func testARetryThatFindsTheOriginalClientsClearsThePendingRetry() {
        var swap = TapSwap<UInt32, Int>()
        let taps = Taps()
        _ = update(&swap, taps, [10: 101])
        taps.failNext = true
        XCTAssertEqual(update(&swap, taps, [10: 101, 11: 102]), "failed")
        XCTAssertEqual(update(&swap, taps, [10: 101]), "unchanged")
        XCTAssertFalse(swap.retryPending)
        XCTAssertEqual(swap.tap, 1)
    }

    func testNoClientsTearsDownWithoutBuildingAndTearDownClears() {
        var swap = TapSwap<UInt32, Int>()
        let taps = Taps()
        _ = update(&swap, taps, [10: 101])
        XCTAssertEqual(update(&swap, taps, [:]), "rebuilt")
        XCTAssertNil(swap.tap)
        _ = update(&swap, taps, [11: 102])
        swap.tearDown(destroy: taps.destroy)
        XCTAssertNil(swap.tap)
        XCTAssertEqual(swap.clients, [:])
        XCTAssertEqual(taps.events, ["build 1 [10]", "destroy 1", "build 2 [11]", "destroy 2"])
    }

    /// Ticks the caller waits, after each failed build of one client set, until the next retry is due.
    private func failingSchedule(_ swap: inout TapSwap<UInt32, Int>, _ taps: Taps, failures: Int) -> [Int] {
        (0 ..< failures).map { _ in
            var waited = 1
            while !swap.retryDue() {
                XCTAssertEqual(update(&swap, taps, [10: 101, 11: 102]), "backing off")
                waited += 1
            }
            _ = update(&swap, taps, [10: 101, 11: 102])
            return waited
        }
    }

    func testARebuildThatKeepsFailingBacksOffDoublingToTheCap() {
        var swap = TapSwap<UInt32, Int>(maxRetryTicks: 8, warnAfterFailures: 100)
        let taps = Taps()
        _ = update(&swap, taps, [10: 101])
        taps.failAlways = true
        XCTAssertEqual(update(&swap, taps, [10: 101, 11: 102]), "failed")
        XCTAssertEqual(failingSchedule(&swap, taps, failures: 6), [1, 2, 4, 8, 8, 8])
        XCTAssertEqual(swap.consecutiveFailures, 7)
        XCTAssertEqual(taps.events.filter { $0.hasPrefix("fail") }.count, 7, "backing off builds nothing")
        XCTAssertEqual(swap.tap, 1, "the running tap keeps capturing")
    }

    func testOnlyTheNthFailureInARowAsksForAWarning() {
        var swap = TapSwap<UInt32, Int>(maxRetryTicks: 1, warnAfterFailures: 3)
        let taps = Taps()
        taps.failAlways = true
        let outcomes = (0 ..< 5).map { _ -> String in
            _ = swap.retryDue()
            return update(&swap, taps, [10: 101, 11: 102])
        }
        XCTAssertEqual(outcomes, ["failed", "failed", "failed, warn", "failed", "failed"])
    }

    func testANewClientSetOrASuccessfulBuildResetsTheBackoff() {
        var swap = TapSwap<UInt32, Int>(maxRetryTicks: 50, warnAfterFailures: 3)
        let taps = Taps()
        taps.failAlways = true
        _ = update(&swap, taps, [10: 101, 11: 102])
        _ = failingSchedule(&swap, taps, failures: 2)
        XCTAssertEqual(swap.ticksUntilRetry, 4)
        // A client set that changed is tried at once, and its failures count from one.
        XCTAssertEqual(update(&swap, taps, [10: 101, 12: 103]), "failed")
        XCTAssertEqual(swap.consecutiveFailures, 1)
        XCTAssertEqual(swap.ticksUntilRetry, 1)
        taps.failAlways = false
        XCTAssertTrue(swap.retryDue())
        XCTAssertEqual(update(&swap, taps, [10: 101, 12: 103]), "rebuilt")
        XCTAssertFalse(swap.retryPending)
        XCTAssertEqual(swap.consecutiveFailures, 0)
        XCTAssertFalse(swap.retryDue())
    }
}
