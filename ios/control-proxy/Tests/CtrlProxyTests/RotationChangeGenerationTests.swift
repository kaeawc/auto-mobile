@testable import CtrlProxy
import XCTest

private final class FakeRotationChangeSignal: RotationChangeSignaling, @unchecked Sendable {
    private var handler: (@Sendable () -> Void)?

    func startObserving(_ handler: @escaping @Sendable () -> Void) {
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
    func testObservedGeometryIsNotReusedAfterOrientationChangeEvenWhenRotationReturnsToPortrait() {
        let signal = FakeRotationChangeSignal()
        let sampler = FakeRotationSampler(rotation: 0)
        let monitor = RotationChangeMonitor(signal: signal)
        let size = GestureSize(width: 402, height: 874)
        let geometry = GestureCoordinateGeometry(app: size, screen: size, observation: size, rotation: 0)
        let cached = ObservedGestureGeometry(
            geometry: geometry, bundleId: "com.test.app", generation: monitor.captureSample(using: sampler).generation
        )
        XCTAssertEqual(cached.current(bundleId: "com.test.app", generation: monitor.generation), geometry)
        XCTAssertNil(cached.current(bundleId: "com.other.app", generation: monitor.generation))

        signal.sendOrientationChange()
        signal.sendOrientationChange()

        XCTAssertNil(cached.current(bundleId: "com.test.app", generation: monitor.generation))
        let refreshed = ObservedGestureGeometry(
            geometry: geometry, bundleId: "com.test.app", generation: monitor.captureSample(using: sampler).generation
        )
        XCTAssertEqual(refreshed.current(bundleId: "com.test.app", generation: monitor.generation), geometry)
    }

    func testGeometryCapturedAcrossOrientationChangeCannotBeReused() {
        let signal = FakeRotationChangeSignal()
        let monitor = RotationChangeMonitor(signal: signal)
        let generationBeforeCapture = monitor.generation
        signal.sendOrientationChange()
        let size = GestureSize(width: 951, height: 669)
        let cached = ObservedGestureGeometry(
            geometry: GestureCoordinateGeometry(app: size, screen: size, observation: size, rotation: 0),
            bundleId: "com.test.app", generation: generationBeforeCapture
        )
        XCTAssertNil(cached.current(bundleId: "com.test.app", generation: monitor.generation))
    }

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
