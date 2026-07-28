@testable import CtrlProxy
import XCTest

private final class FakeRotationChangeSignal: RotationChangeSignaling {
    private var handler: (() -> Void)?

    func startObserving(_ handler: @escaping () -> Void) {
        self.handler = handler
    }

    func sendOrientationChange() {
        handler?()
    }
}

private final class FakeRotationSampler: RotationSampling {
    var rotation: Int?

    init(rotation: Int?) {
        self.rotation = rotation
    }

    func currentRotation() -> Int? {
        rotation
    }
}

final class RotationChangeGenerationTests: XCTestCase {
    func testUsesDeviceRotationSamplerInsteadOfAnyRunnerSceneValue() {
        let signal = FakeRotationChangeSignal()
        let sampler = FakeRotationSampler(rotation: 1)
        let monitor = RotationChangeMonitor(signal: signal)

        let capture = monitor.capture(using: sampler) { "capture" }

        XCTAssertEqual(capture.value, "capture")
        XCTAssertEqual(capture.rotation, 1)
    }

    func testRejectsABARotationWhenChangeSignalDeliversDuringCapture() {
        let signal = FakeRotationChangeSignal()
        let sampler = FakeRotationSampler(rotation: 0)
        let monitor = RotationChangeMonitor(signal: signal)

        let capture = monitor.capture(using: sampler) {
            sampler.rotation = 1
            signal.sendOrientationChange()
            sampler.rotation = 0
            signal.sendOrientationChange()
            return "capture"
        }

        XCTAssertEqual(capture.value, "capture")
        XCTAssertNil(capture.rotation, "A→B→A must invalidate capture rotation")
    }

    func testKeepsRotationWhenNoOrientationChangeOccursDuringCapture() {
        let signal = FakeRotationChangeSignal()
        let sampler = FakeRotationSampler(rotation: 3)
        let monitor = RotationChangeMonitor(signal: signal)

        XCTAssertEqual(monitor.capture(using: sampler) { "capture" }.rotation, 3)
    }
}
