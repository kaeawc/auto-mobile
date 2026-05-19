import CoreMediaIO
import Foundation

/// Enables iOS device screen-capture devices to appear in AVFoundation. This
/// is the same toggle QuickTime Player flips when you select an iOS device.
///
/// Per design doc: rapidly toggling this property can stall device discovery
/// for up to 60 seconds, so we only flip it to `true` and leave it.
enum CMIOSystem {
    static func enableScreenCaptureDevices() {
        var prop = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain)
        )
        var allow: UInt32 = 1
        CMIOObjectSetPropertyData(
            CMIOObjectID(kCMIOObjectSystemObject),
            &prop,
            0,
            nil,
            UInt32(MemoryLayout<UInt32>.size),
            &allow
        )
    }
}
