@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class PrototypeMediaCaptureAvailabilityTests: XCTestCase {
    private struct Probe: PrototypeMediaCaptureProbe {
        var isSimulator: Bool
        var videoCaptureDeviceCount: Int
        var audioInputAvailable: Bool
    }

    private struct Bundle: PrototypeBundleReader {
        var keys: Set<String>
        func containsInfoPlistKey(_ key: String) -> Bool { keys.contains(key) }
    }

    private let allKeys: Set<String> = [
        PrototypeMediaCaptureAvailability.cameraUsageKey,
        PrototypeMediaCaptureAvailability.microphoneUsageKey,
    ]

    func testSimulatorAdvertisesMicrophoneOnlyAndInjectsFrames() {
        // Captured on Xcode 26.6 / iOS 26.5 Simulator: discovery returns [], audio input is available.
        let result = PrototypeMediaCaptureAvailability(
            probe: Probe(isSimulator: true, videoCaptureDeviceCount: 0, audioInputAvailable: true),
            bundle: Bundle(keys: allKeys)
        )
        XCTAssertEqual(result.capabilities, ["prototype_platform_audioRecorder_v1"])
        XCTAssertEqual(result.camera, .unavailable("no_camera"))
        XCTAssertEqual(result.frameSource, .injected)
    }

    func testSimulatorNeverAdvertisesCameraEvenWhenDiscoveryReportsADevice() {
        let result = PrototypeMediaCaptureAvailability(
            probe: Probe(isSimulator: true, videoCaptureDeviceCount: 1, audioInputAvailable: true),
            bundle: Bundle(keys: allKeys)
        )
        XCTAssertFalse(result.capabilities.contains("prototype_platform_camera_v1"))
        XCTAssertEqual(result.frameSource, .injected)
    }

    func testDeviceWithHardwareAndKeysAdvertisesBothWithARealCamera() {
        let result = PrototypeMediaCaptureAvailability(
            probe: Probe(isSimulator: false, videoCaptureDeviceCount: 2, audioInputAvailable: true),
            bundle: Bundle(keys: allKeys)
        )
        XCTAssertEqual(
            result.capabilities, ["prototype_platform_camera_v1", "prototype_platform_audioRecorder_v1"]
        )
        XCTAssertEqual(result.frameSource, .camera)
    }

    func testMissingUsageDescriptionsReportUnavailableWithDetail() {
        let result = PrototypeMediaCaptureAvailability(
            probe: Probe(isSimulator: false, videoCaptureDeviceCount: 1, audioInputAvailable: true),
            bundle: Bundle(keys: [])
        )
        XCTAssertTrue(result.capabilities.isEmpty)
        XCTAssertEqual(result.camera, .unavailable("missing_usage_description"))
        XCTAssertEqual(result.microphone, .unavailable("missing_usage_description"))
    }

    func testDeviceWithoutHardwareHasNoFrames() {
        let result = PrototypeMediaCaptureAvailability(
            probe: Probe(isSimulator: false, videoCaptureDeviceCount: 0, audioInputAvailable: false),
            bundle: Bundle(keys: allKeys)
        )
        XCTAssertTrue(result.capabilities.isEmpty)
        XCTAssertEqual(result.microphone, .unavailable("no_audio_input"))
        XCTAssertEqual(result.frameSource, .none)
    }
}
