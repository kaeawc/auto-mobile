import AVFoundation
import Foundation
import ScreenCaptureCore

/// Discovers USB-connected iOS devices visible to AVFoundation as external
/// muxed (audio + video) capture devices.
enum DeviceDiscovery {
    static func discover() -> [AVCaptureDevice] {
        let types: [AVCaptureDevice.DeviceType] = [.external]
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .muxed,
            position: .unspecified
        ).devices
    }

    static func toInfo(_ device: AVCaptureDevice) -> DeviceInfo {
        DeviceInfo(
            uniqueID: device.uniqueID,
            localizedName: device.localizedName,
            modelID: device.modelID,
            manufacturer: device.manufacturer
        )
    }

    static func find(uniqueID: String) -> AVCaptureDevice? {
        discover().first { $0.uniqueID == uniqueID }
    }
}
