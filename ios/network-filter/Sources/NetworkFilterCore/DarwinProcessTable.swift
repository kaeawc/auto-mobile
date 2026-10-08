import Darwin
import Foundation

/// `ProcessTable` over public libproc, libbsm and sysctl interfaces. Each lookup
/// re-checks the process after reading so a pid reused mid-lookup is rejected
/// rather than misattributed.
public struct DarwinProcessTable: ProcessTable {
    private static let pathCapacity = Int(MAXPATHLEN) * 4
    private static let maximumArgumentCount: Int32 = 4096

    public init() {}

    public func generation(auditToken: Data) -> ProcessGeneration? {
        guard let token = Self.token(auditToken) else { return nil }
        return ProcessGeneration(pid: audit_token_to_pid(token), pidVersion: audit_token_to_pidversion(token))
    }

    public func process(auditToken: Data) -> ProcessRecord? {
        // proc_pidpath_audittoken fails unless the token's pid *and* pid version
        // still name a live process. Reading it again after the BSD info proves
        // that info came from the same generation.
        guard var token = Self.token(auditToken),
              let path = Self.path(token: &token),
              let info = Self.bsdInfo(pid: audit_token_to_pid(token)),
              Self.path(token: &token) == path
        else { return nil }
        return Self.record(pid: audit_token_to_pid(token), info: info, path: path)
    }

    public func process(pid: Int32) -> ProcessRecord? {
        guard let before = Self.bsdInfo(pid: pid),
              let path = Self.path(pid: pid),
              let after = Self.bsdInfo(pid: pid),
              Self.startTime(before) == Self.startTime(after),
              before.pbi_ppid == after.pbi_ppid
        else { return nil }
        return Self.record(pid: pid, info: after, path: path)
    }

    public func arguments(of process: ProcessRecord) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, process.pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0,
              let after = Self.bsdInfo(pid: process.pid),
              Self.startTime(after) == process.startTime
        else { return nil }
        return Self.parseProcessArguments(Array(buffer.prefix(size)))
    }

    /// `KERN_PROCARGS2` layout: `argc` (Int32), the exec path, NUL padding, then
    /// `argc` NUL-terminated arguments followed by the environment, which is ignored.
    static func parseProcessArguments(_ bytes: [UInt8]) -> [String]? {
        guard bytes.count >= MemoryLayout<Int32>.size else { return nil }
        let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard argc >= 0, argc <= maximumArgumentCount else { return nil }
        var index = MemoryLayout<Int32>.size
        while index < bytes.count, bytes[index] != 0 {
            index += 1
        }
        while index < bytes.count, bytes[index] == 0 {
            index += 1
        }
        var arguments: [String] = []
        while arguments.count < Int(argc) {
            guard let end = bytes[index...].firstIndex(of: 0) else { return nil }
            guard let argument = String(bytes: bytes[index ..< end], encoding: .utf8) else { return nil }
            arguments.append(argument)
            index = end + 1
        }
        return arguments
    }

    private static func token(_ data: Data) -> audit_token_t? {
        guard data.count == MemoryLayout<audit_token_t>.size else { return nil }
        var token = audit_token_t()
        _ = withUnsafeMutableBytes(of: &token) { data.copyBytes(to: $0) }
        return token
    }

    private static func path(token: inout audit_token_t) -> String? {
        var buffer = [CChar](repeating: 0, count: pathCapacity)
        guard proc_pidpath_audittoken(&token, &buffer, UInt32(pathCapacity)) > 0 else { return nil }
        return String(cString: buffer)
    }

    private static func path(pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: pathCapacity)
        guard proc_pidpath(pid, &buffer, UInt32(pathCapacity)) > 0 else { return nil }
        return String(cString: buffer)
    }

    private static func bsdInfo(pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return info
    }

    private static func startTime(_ info: proc_bsdinfo) -> UInt64 {
        info.pbi_start_tvsec &* 1_000_000 &+ info.pbi_start_tvusec
    }

    private static func record(pid: Int32, info: proc_bsdinfo, path: String) -> ProcessRecord {
        ProcessRecord(
            pid: pid,
            parentPID: Int32(bitPattern: info.pbi_ppid),
            startTime: startTime(info),
            executablePath: path
        )
    }
}
