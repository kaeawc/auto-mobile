@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeKeyframesTests: XCTestCase {
    func testLinearHitsAuthoredPoint() {
        XCTAssertEqual(keyframeValue(points: [(0, 1), (0.35, 1.3), (1, 1)], curve: "linear", fraction: 0.35), 1.3)
    }

    func testCurvesAreMonotonicAndEndpointsExact() {
        for curve in ["linear", "standard", "spring"] {
            let points: [(Double, Double)] = [(0, 0), (1, 1)]
            XCTAssertEqual(keyframeValue(points: points, curve: curve, fraction: 0), 0)
            XCTAssertEqual(keyframeValue(points: points, curve: curve, fraction: 1), 1)
            let values = (0 ... 100).map { keyframeValue(points: points, curve: curve, fraction: Double($0) / 100) }
            XCTAssertTrue(zip(values, values.dropFirst()).allSatisfy { $0 <= $1 })
        }
    }

    func testProfileFiltering() {
        let tracks: [String: JSONValue] = ["scale": .array([]), "alpha": .array([])]
        XCTAssertEqual(Set(PrototypeKeyframes.filtered(tracks, profile: .full).keys), ["scale", "alpha"])
        XCTAssertEqual(Set(PrototypeKeyframes.filtered(tracks, profile: .reduced).keys), ["alpha"])
        XCTAssertTrue(PrototypeKeyframes.filtered(tracks, profile: .off).isEmpty)
    }

    func testAdvertisementRequiresIOS17() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        XCTAssertFalse(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 16))
                .contains("prototype_keyframes_v1")
        )
        XCTAssertTrue(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 17))
                .contains("prototype_keyframes_v1")
        )
    }

    func testActivityRestartsAndReleasesWithoutWaiting() {
        final class Timer: PrototypeTimerHandle {
            let fire: () -> Void
            var cancelled = false
            init(_ fire: @escaping () -> Void) { self.fire = fire }
            func cancel() { cancelled = true }
        }
        final class Clock: PrototypeClock {
            var timers: [Timer] = []
            func schedule(afterMilliseconds _: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
                let timer = Timer(fire)
                timers.append(timer)
                return timer
            }
        }
        let clock = Clock()
        let activity = PrototypeKeyframeActivity(clock: clock)
        let owner = UUID()
        XCTAssertEqual(activity.active, 0)
        activity.play(owner: owner, durationMs: 600)
        activity.play(owner: owner, durationMs: 600)
        XCTAssertEqual(activity.active, 1)
        XCTAssertTrue(clock.timers[0].cancelled)
        clock.timers[0].fire() // A cancelled callback arriving late cannot finish the restarted play.
        XCTAssertEqual(activity.active, 1)
        clock.timers[1].fire()
        XCTAssertEqual(activity.active, 0)
        activity.play(owner: owner, durationMs: 600)
        activity.stop(owner: owner)
        XCTAssertEqual(activity.active, 0)
    }
}
