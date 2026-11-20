@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeOrientationLockTests: XCTestCase {
    private final class Owner {}

    private final class Driver: PrototypeOrientationDriver {
        enum Call: Equatable {
            case lock(PrototypeWindowOrientation)
            case restore(PrototypeOrientationBaseline)
        }

        var baseline: PrototypeOrientationBaseline = .portrait
        var calls: [Call] = []
        var hostRestores = 0

        func applyLock(_ orientation: PrototypeWindowOrientation) {
            calls.append(.lock(orientation))
            baseline = orientation == .landscape ? .landscapeLeft : .portrait
        }

        func restoreBaseline(_ baseline: PrototypeOrientationBaseline) {
            calls.append(.restore(baseline))
            if baseline == .unknown { hostRestores += 1 }
            self.baseline = baseline
        }
    }

    func testLastReleaseRestoresPortraitExactlyOnce() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let owner = Owner()
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .landscape)
        lock.release(owner: ObjectIdentifier(owner))
        XCTAssertEqual(driver.calls, [.lock(.landscape), .restore(.portrait)])
        XCTAssertTrue(lock.isEmpty)
    }

    func testReacquireKeepsFirstBaselineWhileLandscapeIsCurrent() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let owner = Owner()
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .landscape)
        XCTAssertEqual(driver.baseline, .landscapeLeft)
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .portrait)
        lock.release(owner: ObjectIdentifier(owner))
        XCTAssertEqual(driver.calls, [.lock(.landscape), .lock(.portrait), .restore(.portrait)])
    }

    func testReleasingOlderOwnerKeepsNewerLockAndFirstBaseline() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let older = Owner()
        let newer = Owner()
        lock.acquire(owner: ObjectIdentifier(older), orientation: .landscape)
        lock.acquire(owner: ObjectIdentifier(newer), orientation: .portrait)
        lock.release(owner: ObjectIdentifier(older))
        XCTAssertEqual(driver.calls, [.lock(.landscape), .lock(.portrait), .lock(.portrait)])
        XCTAssertFalse(lock.isEmpty)
        lock.release(owner: ObjectIdentifier(newer))
        XCTAssertEqual(driver.calls.last, .restore(.portrait))
    }

    func testReleasingNewerOwnerReappliesOlderLockThenRestoresPortrait() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let older = Owner()
        let newer = Owner()
        lock.acquire(owner: ObjectIdentifier(older), orientation: .landscape)
        lock.acquire(owner: ObjectIdentifier(newer), orientation: .portrait)
        lock.release(owner: ObjectIdentifier(newer))
        lock.release(owner: ObjectIdentifier(older))
        XCTAssertEqual(driver.calls, [
            .lock(.landscape), .lock(.portrait), .lock(.landscape), .restore(.portrait),
        ])
    }

    func testReplacementRestoresOnlyAcrossAnEmptyOwnerSet() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let first = Owner()
        let replacement = Owner()
        lock.acquire(owner: ObjectIdentifier(first), orientation: .landscape)
        lock.acquire(owner: ObjectIdentifier(replacement), orientation: .portrait)
        lock.release(owner: ObjectIdentifier(first))
        XCTAssertEqual(driver.calls, [.lock(.landscape), .lock(.portrait), .lock(.portrait)])
        lock.release(owner: ObjectIdentifier(replacement))
        lock.acquire(owner: ObjectIdentifier(first), orientation: .landscape)
        lock.release(owner: ObjectIdentifier(first))
        XCTAssertEqual(driver.calls, [
            .lock(.landscape), .lock(.portrait), .lock(.portrait), .restore(.portrait),
            .lock(.landscape), .restore(.portrait),
        ])
    }

    func testDoubleReleaseAndUnknownOwnerAreNoOps() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let owner = Owner()
        let stranger = Owner()
        lock.release(owner: ObjectIdentifier(stranger))
        XCTAssertTrue(driver.calls.isEmpty)
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .landscape)
        lock.release(owner: ObjectIdentifier(stranger))
        XCTAssertEqual(driver.calls, [.lock(.landscape)])
        lock.release(owner: ObjectIdentifier(owner))
        lock.release(owner: ObjectIdentifier(owner))
        XCTAssertEqual(driver.calls, [.lock(.landscape), .restore(.portrait)])
    }

    func testUnknownBaselineFallsBackToHostRestore() {
        let driver = Driver()
        driver.baseline = .unknown
        let lock = PrototypeOrientationLock(driver: driver)
        let owner = Owner()
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .landscape)
        lock.release(owner: ObjectIdentifier(owner))
        XCTAssertEqual(driver.calls, [.lock(.landscape), .restore(.unknown)])
        XCTAssertEqual(driver.hostRestores, 1)
    }

    func testNextLockCycleCapturesFreshBaseline() {
        let driver = Driver()
        let lock = PrototypeOrientationLock(driver: driver)
        let owner = Owner()
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .landscape)
        lock.release(owner: ObjectIdentifier(owner))
        driver.baseline = .portraitUpsideDown
        lock.acquire(owner: ObjectIdentifier(owner), orientation: .landscape)
        lock.release(owner: ObjectIdentifier(owner))
        XCTAssertEqual(driver.calls.last, .restore(.portraitUpsideDown))
    }
}
