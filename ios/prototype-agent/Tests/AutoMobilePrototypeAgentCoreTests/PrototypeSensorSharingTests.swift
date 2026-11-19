@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
private final class FakeProximityMonitoringControl: ProximityMonitoringControl {
    private var enabled: Bool
    private let supported: Bool
    private(set) var writes: [Bool] = []

    init(isEnabled: Bool, supported: Bool = true) {
        enabled = isEnabled
        self.supported = supported
    }

    var isEnabled: Bool {
        get { enabled }
        set {
            writes.append(newValue)
            enabled = newValue && supported
        }
    }
}

@MainActor
private final class FakePrototypeMotionManager: PrototypeMotionManager {
    var isDeviceMotionAvailable = true
    var isAccelerometerAvailable = true
    private(set) var updates: [PrototypeMotionKind: [@MainActor @Sendable (PrototypeSensorSample) -> Void]] = [:]
    private(set) var stops: [PrototypeMotionKind: Int] = [:]

    func startDeviceMotionUpdates(_ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void) {
        updates[.deviceMotion, default: []].append(handler)
    }

    func stopDeviceMotionUpdates() { stops[.deviceMotion, default: 0] += 1 }

    func startAccelerometerUpdates(_ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void) {
        updates[.accelerometer, default: []].append(handler)
    }

    func stopAccelerometerUpdates() { stops[.accelerometer, default: 0] += 1 }

    func report(_ kind: PrototypeMotionKind, _ sample: PrototypeSensorSample, run: Int = 0) {
        updates[kind]?[run](sample)
    }
}

@MainActor
private final class SharedMotionReadings {
    private(set) var values: [Double] = []

    func receive(_ sample: PrototypeSensorSample) {
        switch sample {
        case let .values(fields):
            if let pitch = fields["pitchDeg"] { values.append(pitch) }
        case let .acceleration(x, _, _): values.append(x)
        case .proximity: XCTFail("Motion must deliver orientation or acceleration")
        }
    }
}

@MainActor
final class PrototypeSensorSharingTests: XCTestCase {
    func testProximityRestoresBothHostSettingsAndIgnoresExtraReleases() {
        for prior in [true, false] {
            let control = FakeProximityMonitoringControl(isEnabled: prior)
            let scope = ProximityMonitoringScope(control: control)
            scope.release()
            XCTAssertEqual(control.writes, [])
            scope.acquire()
            XCTAssertTrue(control.isEnabled)
            XCTAssertEqual(control.writes, [true])
            scope.release()
            XCTAssertEqual(control.isEnabled, prior)
            XCTAssertEqual(control.writes, [true, prior])
            scope.release()
            XCTAssertEqual(control.writes, [true, prior])

            control.isEnabled = !prior
            scope.acquire()
            scope.release()
            XCTAssertEqual(control.isEnabled, !prior, "A new scope lifetime captures the host's current setting")
        }
    }

    func testProximityKeepsMonitoringUntilBothAcquirersRelease() {
        for prior in [true, false] {
            let control = FakeProximityMonitoringControl(isEnabled: prior)
            let scope = ProximityMonitoringScope(control: control)
            scope.acquire()
            scope.acquire()
            XCTAssertEqual(control.writes, [true], "Only the first acquire enables monitoring")
            scope.release()
            XCTAssertTrue(control.isEnabled)
            XCTAssertEqual(control.writes, [true])
            scope.release()
            XCTAssertEqual(control.isEnabled, prior)
            XCTAssertEqual(control.writes, [true, prior])
            scope.release()
            XCTAssertEqual(control.writes, [true, prior])
        }
    }

    func testProximityProbeRestoresTheHostSettingWithoutAcquiring() {
        for prior in [true, false] {
            let control = FakeProximityMonitoringControl(isEnabled: prior)
            let scope = ProximityMonitoringScope(control: control)
            XCTAssertTrue(scope.probe())
            XCTAssertEqual(control.isEnabled, prior)
            XCTAssertEqual(control.writes, [true, prior])
            scope.release()
            XCTAssertEqual(control.writes, [true, prior], "A probe must not leave a reference to release")
        }
        let unsupported = FakeProximityMonitoringControl(isEnabled: false, supported: false)
        XCTAssertFalse(ProximityMonitoringScope(control: unsupported).probe())
        XCTAssertFalse(unsupported.isEnabled)
        XCTAssertEqual(unsupported.writes, [true, false])
    }

    func testProximityProbeDoesNotWriteOrReleaseWhileAcquired() {
        for prior in [true, false] {
            let control = FakeProximityMonitoringControl(isEnabled: prior)
            let scope = ProximityMonitoringScope(control: control)
            scope.acquire()
            XCTAssertTrue(scope.probe())
            XCTAssertEqual(control.writes, [true])
            control.isEnabled = false
            XCTAssertFalse(scope.probe(), "An active probe reads back the current host state")
            XCTAssertEqual(control.writes, [true, false])
            scope.release()
            XCTAssertEqual(control.isEnabled, prior)
            XCTAssertEqual(control.writes, [true, false, prior])
        }
    }

    func testMotionSharesEachStreamAndFansOutUntilTheLastRelease() {
        for kind in PrototypeMotionKind.allCases {
            let manager = FakePrototypeMotionManager()
            let motion = SharedPrototypeMotion(manager: manager)
            let first = SharedMotionReadings()
            let second = SharedMotionReadings()
            let firstID = motion.acquire(kind) { first.receive($0) }
            let secondID = motion.acquire(kind) { second.receive($0) }
            XCTAssertEqual(manager.updates[kind]?.count, 1)
            manager.report(kind, sample(kind, value: 3))
            XCTAssertEqual(first.values, [3])
            XCTAssertEqual(second.values, [3])

            motion.release(kind, id: firstID)
            motion.release(kind, id: firstID)
            XCTAssertEqual(manager.stops[kind, default: 0], 0)
            manager.report(kind, sample(kind, value: 7))
            XCTAssertEqual(first.values, [3])
            XCTAssertEqual(second.values, [3, 7])
            motion.release(kind, id: secondID)
            XCTAssertEqual(manager.stops[kind], 1)
            manager.report(kind, sample(kind, value: 9))
            XCTAssertEqual(second.values, [3, 7])
            motion.release(kind, id: secondID)
            motion.release(kind, id: -1)
            XCTAssertEqual(manager.stops[kind], 1)
        }
    }

    func testMotionRejectsOldCallbacksAfterRestartingEachStream() {
        for kind in PrototypeMotionKind.allCases {
            let manager = FakePrototypeMotionManager()
            let motion = SharedPrototypeMotion(manager: manager)
            let readings = SharedMotionReadings()
            let oldID = motion.acquire(kind) { readings.receive($0) }
            motion.release(kind, id: oldID)
            let newID = motion.acquire(kind) { readings.receive($0) }
            XCTAssertEqual(manager.updates[kind]?.count, 2)
            manager.report(kind, sample(kind, value: 1), run: 0)
            manager.report(kind, sample(kind, value: 2), run: 1)
            XCTAssertEqual(readings.values, [2])
            motion.release(kind, id: oldID)
            XCTAssertEqual(manager.stops[kind], 1)
            motion.release(kind, id: newID)
            XCTAssertEqual(manager.stops[kind], 2)
        }
    }

    func testMotionKindsHaveIndependentLifetimesAndAvailability() {
        let manager = FakePrototypeMotionManager()
        let motion = SharedPrototypeMotion(manager: manager)
        manager.isDeviceMotionAvailable = false
        XCTAssertFalse(motion.isDeviceMotionAvailable)
        XCTAssertTrue(motion.isAccelerometerAvailable)
        manager.isDeviceMotionAvailable = true
        manager.isAccelerometerAvailable = false
        XCTAssertTrue(motion.isDeviceMotionAvailable)
        XCTAssertFalse(motion.isAccelerometerAvailable)
        manager.isAccelerometerAvailable = true

        let deviceMotionID = motion.acquire(.deviceMotion) { _ in }
        let accelerometerID = motion.acquire(.accelerometer) { _ in }
        XCTAssertEqual(manager.updates[.deviceMotion]?.count, 1)
        XCTAssertEqual(manager.updates[.accelerometer]?.count, 1)
        motion.release(.deviceMotion, id: accelerometerID)
        XCTAssertEqual(manager.stops[.deviceMotion, default: 0], 0)
        motion.release(.deviceMotion, id: deviceMotionID)
        XCTAssertEqual(manager.stops[.deviceMotion], 1)
        XCTAssertEqual(manager.stops[.accelerometer, default: 0], 0)
        motion.release(.accelerometer, id: accelerometerID)
        XCTAssertEqual(manager.stops[.accelerometer], 1)
    }

    private func sample(_ kind: PrototypeMotionKind, value: Double) -> PrototypeSensorSample {
        switch kind {
        case .deviceMotion: .values(["pitchDeg": value])
        case .accelerometer: .acceleration(x: value, y: 0, z: 0)
        }
    }
}
