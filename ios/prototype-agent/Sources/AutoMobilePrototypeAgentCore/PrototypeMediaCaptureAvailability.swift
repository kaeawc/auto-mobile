import Foundation

/// What the host can capture, read without starting a capture or prompting. Injected so the
/// Simulator and device rules run in unit tests (#18798).
@MainActor
protocol PrototypeMediaCaptureProbe {
    /// True when running in the iOS Simulator (`targetEnvironment(simulator)`).
    var isSimulator: Bool { get }
    /// The number of video capture devices AVFoundation discovery returns.
    var videoCaptureDeviceCount: Int { get }
    /// `AVAudioSession.isInputAvailable`.
    var audioInputAvailable: Bool { get }
}

/// Where the live viewfinder's frames come from; the `/platform/camera/source` state values.
enum PrototypeCameraFrameSource: String, Equatable, Sendable {
    /// A real capture device.
    case camera
    /// Injected still or video frames, the only source on a Simulator.
    case injected
    /// No viewfinder frames at all.
    case none
}

/// The camera and microphone rule for the iOS runtimes. A Simulator has no capture devices
/// (discovery returns none) but an audio input, so it advertises the microphone module only and
/// serves the viewfinder from injected frames. A device with hardware advertises a module only
/// when its usage description is in the Info.plist; otherwise it reports `unavailable` with detail
/// `missing_usage_description`.
@MainActor
struct PrototypeMediaCaptureAvailability: Equatable {
    static let cameraCapability = "prototype_platform_camera_v1"
    static let microphoneCapability = "prototype_platform_audioRecorder_v1"
    static let cameraUsageKey = "NSCameraUsageDescription"
    static let microphoneUsageKey = "NSMicrophoneUsageDescription"

    let camera: PlatformAvailability
    let microphone: PlatformAvailability
    let frameSource: PrototypeCameraFrameSource

    init(probe: any PrototypeMediaCaptureProbe, bundle: any PrototypeBundleReader) {
        let hasCamera = !probe.isSimulator && probe.videoCaptureDeviceCount > 0
        camera = Self.availability(
            present: hasCamera, absentDetail: "no_camera", key: Self.cameraUsageKey, bundle: bundle
        )
        microphone = Self.availability(
            present: probe.audioInputAvailable, absentDetail: "no_audio_input",
            key: Self.microphoneUsageKey, bundle: bundle
        )
        if hasCamera {
            frameSource = .camera
        } else {
            frameSource = probe.isSimulator ? .injected : .none
        }
    }

    /// The capabilities a runtime registers for what it can capture.
    var capabilities: [String] {
        var result: [String] = []
        if camera == .ready { result.append(Self.cameraCapability) }
        if microphone == .ready { result.append(Self.microphoneCapability) }
        return result
    }

    private static func availability(
        present: Bool, absentDetail: String, key: String, bundle: any PrototypeBundleReader
    )
        -> PlatformAvailability
    {
        guard present else { return .unavailable(absentDetail) }
        return bundle.containsInfoPlistKey(key) ? .ready : .unavailable("missing_usage_description")
    }
}
