@testable import CtrlProxy
import XCTest

#if os(iOS)
    import UIKit
#endif

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
    func testCapturesRotationUsingInjectedSampler() {
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

    func testRejectsABARotationBetweenHierarchyCapturePhases() {
        let signal = FakeRotationChangeSignal()
        let sampler = FakeRotationSampler(rotation: 0)
        let monitor = RotationChangeMonitor(signal: signal)

        let beforeHierarchy = monitor.captureSample(using: sampler)
        XCTAssertEqual(monitor.capture(using: sampler) { "app snapshot" }.rotation, 0)

        sampler.rotation = 1
        signal.sendOrientationChange()
        sampler.rotation = 0
        signal.sendOrientationChange()

        XCTAssertEqual(monitor.capture(using: sampler) { "SpringBoard snapshot" }.rotation, 0)
        let afterHierarchy = monitor.captureSample(using: sampler)

        XCTAssertNil(
            RotationCaptureSample.stableRotation(between: beforeHierarchy, and: afterHierarchy),
            "A→B→A between the app and SpringBoard snapshots must invalidate hierarchy rotation"
        )
    }

    func testKeepsRotationWhenNoOrientationChangeOccursDuringCapture() {
        let signal = FakeRotationChangeSignal()
        let sampler = FakeRotationSampler(rotation: 3)
        let monitor = RotationChangeMonitor(signal: signal)

        XCTAssertEqual(monitor.capture(using: sampler) { "capture" }.rotation, 3)
    }

    #if os(iOS)
        func testGestureOrientationKeepsLandscapeSceneWhenDeviceIsFaceUp() {
            let orientation = DeviceRotation.gestureInterfaceOrientation(
                activeSceneOrientation: .landscapeLeft,
                sceneOrientation: .portrait,
                deviceOrientation: .faceUp
            )

            XCTAssertEqual(orientation, .landscapeLeft)
        }
    #endif
}
