@testable import AudioLoopbackCore
import XCTest

final class TapSwapTests: XCTestCase {
    private struct BuildFailed: Error {}

    private final class Taps {
        var events: [String] = []
        var failNext = false
        private var next = 0

        func build(_ clients: [UInt32: Int32]) throws -> Int {
            if failNext {
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
        case .failed: "failed"
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
}
