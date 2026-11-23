import AudioLoopbackCore
import CoreAudio
import Darwin
import Foundation

/// The host Core Audio clients that belong to one iOS Simulator: process objects whose PID descends
/// from the device's `launchd_sim` (#19046).
enum SimulatorAudioClients {
    /// Whether `pid` is a running process.
    static func isRunning(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// The process objects of `launchdPid`'s descendants that are Core Audio clients right now, with
    /// their PIDs: the HAL reuses an object ID for a later process, so the pair identifies a client.
    static func current(launchdPid: Int32) -> [AudioObjectID: Int32] {
        let device = ProcessTree.descendants(of: launchdPid, parents: processParents())
        guard !device.isEmpty else {
            return [:]
        }
        var clients: [AudioObjectID: Int32] = [:]
        for object in processObjects() {
            let pid = pid(of: object)
            if device.contains(pid) {
                clients[object] = pid
            }
        }
        return clients
    }

    /// Every process's parent, from libproc.
    private static func processParents() -> [Int32: Int32] {
        let capacity = Int(proc_listallpids(nil, 0)) + 64
        var pids = [Int32](repeating: 0, count: max(capacity, 64))
        let count = pids.withUnsafeMutableBytes { raw in
            proc_listallpids(raw.baseAddress, Int32(raw.count))
        }
        var parents: [Int32: Int32] = [:]
        for pid in pids.prefix(max(0, Int(count))) where pid > 0 {
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            if proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size {
                parents[pid] = Int32(info.pbi_ppid)
            }
        }
        return parents
    }

    private static func processObjects() -> [AudioObjectID] {
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &property, 0, nil, &size) == noErr, size > 0 else {
            return []
        }
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &property, 0, nil, &size, &objects) == noErr else {
            return []
        }
        return objects
    }

    private static func pid(of object: AudioObjectID) -> Int32 {
        var property = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        guard AudioObjectGetPropertyData(object, &property, 0, nil, &size, &pid) == noErr else {
            return -1
        }
        return pid
    }
}

/// The host's System Audio Recording permission for this process's responsible app, which a process
/// tap needs. Without it the tap is created but delivers silence, so the state is reported up front.
enum AudioCapturePermission {
    /// `authorized`, `denied` or `undetermined`; `unknown` when the preflight is unavailable.
    static func state() -> String {
        typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
        guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
              let symbol = dlsym(handle, "TCCAccessPreflight")
        else {
            return "unknown"
        }
        let preflight = unsafeBitCast(symbol, to: Preflight.self)
        switch preflight("kTCCServiceAudioCapture" as CFString, nil) {
        case 0:
            return "authorized"
        case 1:
            return "denied"
        default:
            return "undetermined"
        }
    }
}
