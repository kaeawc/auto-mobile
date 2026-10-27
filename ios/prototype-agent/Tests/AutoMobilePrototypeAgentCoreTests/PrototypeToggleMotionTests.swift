@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class ToggleTimer: PrototypeTimerHandle {
    let fire: () -> Void
    var cancelled = false
    init(_ fire: @escaping () -> Void) { self.fire = fire }
    func cancel() { cancelled = true }
}

private final class ToggleClock: PrototypeClock {
    var timers: [ToggleTimer] = []
    var delays: [Int] = []
    func schedule(afterMilliseconds delay: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = ToggleTimer(fire)
        timers.append(timer)
        delays.append(delay)
        return timer
    }
}

final class PrototypeToggleMotionTests: XCTestCase {
    func testNativeToggleActivityExpiresRestartsAndSnapsOff() {
        let clock = ToggleClock()
        let activity = PrototypeKeyframeActivity(clock: clock)
        let owner = UUID()
        PrototypeComponentLook.trackToggleMotion(profile: .off, owner: owner, activity: activity)
        XCTAssertEqual(activity.active, 0)
        XCTAssertTrue(clock.timers.isEmpty)
        PrototypeComponentLook.trackToggleMotion(profile: .full, owner: owner, activity: activity)
        XCTAssertEqual(activity.active, 1)
        XCTAssertEqual(clock.delays, [300])
        PrototypeComponentLook.trackToggleMotion(profile: .reduced, owner: owner, activity: activity)
        XCTAssertEqual(activity.active, 1)
        XCTAssertTrue(clock.timers[0].cancelled)
        clock.timers[0].fire()
        XCTAssertEqual(activity.active, 1)
        clock.timers[1].fire()
        XCTAssertEqual(activity.active, 0)
        PrototypeComponentLook.trackToggleMotion(profile: .full, owner: owner, activity: activity)
        PrototypeComponentLook.trackToggleMotion(profile: .off, owner: owner, activity: activity)
        XCTAssertTrue(clock.timers[2].cancelled)
        XCTAssertEqual(activity.active, 0)
    }
}
