import Foundation
@testable import NetworkFilterCore

/// In-memory process table. Tokens use the audit_token_t layout (pid in word 5,
/// pid version in word 7), and a token only resolves while that exact
/// generation is live.
final class FakeProcessTable: ProcessTable {
    struct Entry {
        let record: ProcessRecord
        let pidVersion: Int32
        let arguments: [String]?
    }

    private(set) var live: [Int32: Entry] = [:]
    var failTokenLookups = false
    var failArgumentLookups = false
    /// Replaces the process at a pid the first time the walk reads it, as a
    /// parent exiting and its pid being reused mid-walk would.
    var replaceOnPIDLookup: [Int32: Entry] = [:]

    static func token(pid: Int32, pidVersion: Int32) -> Data {
        var words = [UInt32](repeating: 0, count: 8)
        words[5] = UInt32(bitPattern: pid)
        words[7] = UInt32(bitPattern: pidVersion)
        return words.withUnsafeBytes { Data($0) }
    }

    @discardableResult
    func add(
        pid: Int32,
        pidVersion: Int32 = 1,
        parent: Int32,
        startTime: UInt64 = 1000,
        path: String,
        arguments: [String]? = nil
    )
        -> Data
    {
        live[pid] = Entry(
            record: ProcessRecord(pid: pid, parentPID: parent, startTime: startTime, executablePath: path),
            pidVersion: pidVersion,
            arguments: arguments
        )
        return Self.token(pid: pid, pidVersion: pidVersion)
    }

    func generation(auditToken: Data) -> ProcessGeneration? {
        guard auditToken.count == 32 else { return nil }
        let words = auditToken.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
        return ProcessGeneration(pid: Int32(bitPattern: words[5]), pidVersion: Int32(bitPattern: words[7]))
    }

    /// Runs on every token lookup, to interleave work with an in-flight attribution.
    var onTokenLookup: (() -> Void)?
    private(set) var tokenLookups = 0

    func process(auditToken: Data) -> ProcessRecord? {
        tokenLookups += 1
        onTokenLookup?()
        guard !failTokenLookups,
              let generation = generation(auditToken: auditToken),
              let entry = live[generation.pid],
              entry.pidVersion == generation.pidVersion
        else { return nil }
        return entry.record
    }

    func process(pid: Int32) -> ProcessRecord? {
        if let replacement = replaceOnPIDLookup.removeValue(forKey: pid) {
            live[pid] = replacement
        }
        return live[pid]?.record
    }

    func arguments(of process: ProcessRecord) -> [String]? {
        guard !failArgumentLookups, let entry = live[process.pid], entry.record == process else { return nil }
        return entry.arguments
    }
}

/// Captured on 2026-10-08 from a booted iOS 26.5 simulator on macOS 26
/// (`ps -o pid,ppid,args`, and `ls` of the device's application container).
/// `launchd_sim`'s parent is the host launchd (pid 1); `nsurlsessiond` is its
/// direct child and runs from the shared runtime root.
enum CapturedSimulator {
    static let defaultDeviceSet = "/Users/jason/Library/Developer/CoreSimulator/Devices"
    static let udid = "DFBF2D27-6674-42EA-AFC4-AB702275D1D4"
    static let launchdSimPath = "/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/CoreSimulator/" +
        "Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/sbin/launchd_sim"
    static let nsurlsessiondPath = "/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/" +
        "CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/nsurlsessiond"

    static func launchdSimArguments(deviceSet: String = defaultDeviceSet, udid: String = udid) -> [String] {
        ["launchd_sim", "\(deviceSet)/\(udid)/data/var/run/launchd_bootstrap.plist"]
    }

    static func appExecutable(deviceSet: String = defaultDeviceSet, udid: String = udid) -> String {
        "\(deviceSet)/\(udid)/data/Containers/Bundle/Application/D8F388EF-2F62-4851-B92A-2ACC58B0693F/" +
            "CtrlProxyUITests-Runner.app/CtrlProxyUITests-Runner"
    }
}
