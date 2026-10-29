import AudioLoopbackCore
import CoreAudio
import Foundation

/// A host device the helper opens by UID, the only handle that is stable across HAL restarts.
struct LoopbackDevice {
    let uid: String
    let name: String
}

/// CoreAudio HAL reads. These work without a GUI session (an SSH or LaunchDaemon user).
enum CoreAudioDevices {
    /// The device an iOS Simulator records from: the host default input, which must also have an output
    /// side (a loopback device) so the helper can play into it.
    static func injectionTarget() throws -> LoopbackDevice {
        try loopbackDevice(
            default: kAudioHardwarePropertyDefaultInputDevice,
            otherSide: kAudioObjectPropertyScopeOutput,
            failure: .noLoopbackInput,
            role: "default input"
        )
    }

    /// The device an iOS Simulator plays to: the host default output, which must also have an input side
    /// (a loopback device) so the helper can read it back.
    static func captureSource() throws -> LoopbackDevice {
        try loopbackDevice(
            default: kAudioHardwarePropertyDefaultOutputDevice,
            otherSide: kAudioObjectPropertyScopeInput,
            failure: .noLoopbackOutput,
            role: "default output"
        )
    }

    private static func loopbackDevice(
        default selector: AudioObjectPropertySelector,
        otherSide scope: AudioObjectPropertyScope,
        failure: LoopbackFailure,
        role: String
    ) throws -> LoopbackDevice {
        guard let deviceID = defaultDevice(selector) else {
            throw LoopbackError(failure, "The host has no \(role) device. Install a loopback device such as "
                + "BlackHole 2ch and make it the \(role).")
        }
        let name = string(deviceID, selector: kAudioObjectPropertyName) ?? "unnamed device"
        let virtual = transportType(deviceID) == kAudioDeviceTransportTypeVirtual
        guard streamCount(deviceID, scope: scope) > 0,
              LoopbackDeviceRule.isLoopback(isVirtualTransport: virtual, name: name)
        else {
            throw LoopbackError(failure, "The host \(role) '\(name)' is not a loopback device, so the "
                + "simulator's audio cannot be routed through it. Make a loopback device such as BlackHole 2ch "
                + "the \(role).")
        }
        guard let uid = string(deviceID, selector: kAudioDevicePropertyDeviceUID) else {
            throw LoopbackError(.audioFailed, "The host \(role) '\(name)' reports no device UID.")
        }
        return LoopbackDevice(uid: uid, name: name)
    }

    private static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
        var property = address(selector)
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &property,
            0,
            nil,
            &size,
            &deviceID
        )
        guard status == noErr, deviceID != kAudioObjectUnknown else {
            return nil
        }
        return deviceID
    }

    private static func transportType(_ deviceID: AudioObjectID) -> UInt32? {
        var property = address(kAudioDevicePropertyTransportType)
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(deviceID, &property, 0, nil, &size, &transport) == noErr else {
            return nil
        }
        return transport
    }

    private static func streamCount(_ deviceID: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var property = address(kAudioDevicePropertyStreams, scope: scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &property, 0, nil, &size) == noErr else {
            return 0
        }
        return Int(size) / MemoryLayout<AudioStreamID>.size
    }

    private static func string(_ deviceID: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
        var property = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(deviceID, &property, 0, nil, &size, pointer)
        }
        guard status == noErr, let value else {
            return nil
        }
        return value.takeRetainedValue() as String
    }
}

/// A failure with the code the daemon maps to a tool error.
struct LoopbackError: Error {
    let failure: LoopbackFailure
    let message: String

    init(_ failure: LoopbackFailure, _ message: String) {
        self.failure = failure
        self.message = message
    }

    static func status(_ status: OSStatus, _ action: String) -> LoopbackError {
        LoopbackError(.audioFailed, "\(action) failed (OSStatus \(status)).")
    }
}
