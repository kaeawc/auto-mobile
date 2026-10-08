import Foundation

/// One simulator the host manages, named by the device set it runs from and its
/// UDID. The host supplies these; the resolver never assumes the default
/// `~/Library/Developer/CoreSimulator/Devices` set or any other location.
public struct ManagedSimulator: Codable, Hashable {
    public static let maximumCount = 256

    public let deviceSet: String
    public let udid: String

    /// Returns `nil` unless `deviceSet` is an absolute path below `/` without
    /// `.`/`..` components and `udid` is a UUID. The UDID is upper-cased, which is
    /// how CoreSimulator names device directories.
    public init?(deviceSet: String, udid: String) {
        guard let normalizedSet = Self.normalized(deviceSet: deviceSet),
              let normalizedUDID = UUID(uuidString: udid)?.uuidString
        else { return nil }
        self.deviceSet = normalizedSet
        self.udid = normalizedUDID
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let deviceSet = try container.decode(String.self, forKey: .deviceSet)
        let udid = try container.decode(String.self, forKey: .udid)
        guard let value = ManagedSimulator(deviceSet: deviceSet, udid: udid) else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "A managed simulator needs an absolute device-set path and a UUID"
            ))
        }
        self = value
    }

    private static func normalized(deviceSet: String) -> String? {
        guard deviceSet.hasPrefix("/") else { return nil }
        let components = deviceSet.split(separator: "/")
        guard !components.isEmpty, !components.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return "/" + components.joined(separator: "/")
    }
}

public enum ManagedSimulatorArgumentError: Error, Equatable, CustomStringConvertible {
    case unexpectedArgument(String)
    case missingValue
    case invalidSimulator(deviceSet: String, udid: String)
    case tooMany

    public var description: String {
        switch self {
        case let .unexpectedArgument(argument):
            "Unexpected argument '\(argument)'; use --managed <device-set-path> <udid>"
        case .missingValue:
            "--managed needs a device-set path and a UDID"
        case let .invalidSimulator(deviceSet, udid):
            "--managed '\(deviceSet)' '\(udid)' needs an absolute device-set path and a UUID"
        case .tooMany:
            "At most \(ManagedSimulator.maximumCount) managed simulators are accepted"
        }
    }
}

public enum ManagedSimulatorArguments {
    /// Parses repeated `--managed <device-set-path> <udid>` pairs. `canonicalize`
    /// maps each device-set path to the form the kernel reports for executables
    /// (the controller resolves symlinks with `realpath`).
    public static func parse(
        _ arguments: [String],
        canonicalize: (String) -> String
    )
        throws -> [ManagedSimulator]
    {
        var remaining = arguments[...]
        var simulators: [ManagedSimulator] = []
        while let flag = remaining.popFirst() {
            guard flag == "--managed" else { throw ManagedSimulatorArgumentError.unexpectedArgument(flag) }
            guard let deviceSet = remaining.popFirst(), let udid = remaining.popFirst() else {
                throw ManagedSimulatorArgumentError.missingValue
            }
            guard let simulator = ManagedSimulator(deviceSet: canonicalize(deviceSet), udid: udid) else {
                throw ManagedSimulatorArgumentError.invalidSimulator(deviceSet: deviceSet, udid: udid)
            }
            simulators.append(simulator)
        }
        guard simulators.count <= ManagedSimulator.maximumCount else { throw ManagedSimulatorArgumentError.tooMany }
        return simulators
    }
}

/// How a flow's simulator was found. Each method is a hypothesis that the signed
/// run in #10263 confirms or rejects.
public enum SimulatorAttributionMethod: String, Codable {
    /// The executable lives under `<deviceSet>/<UDID>/data/Containers/Bundle/Application/`.
    case executablePath = "executable_path"
    /// A runtime-hosted helper whose parent chain reaches that simulator's `launchd_sim`.
    case launchdSimAncestor = "launchd_sim_ancestor"
    case unattributed
}

public enum FlowAttributionStatus: String, Codable {
    /// Exactly one managed simulator, one app and one process generation.
    case attributed
    /// Allowed and reported; nothing may ever select it.
    case unattributed
    /// The source-app and source-process tokens name different simulators.
    case conflicting
}

public enum FlowAttributionReason: String, Codable {
    case noAuditToken = "no_audit_token"
    /// The token's pid and pid version no longer name a live process (exited or
    /// pid reused), or the lookup was denied.
    case processUnavailable = "process_unavailable"
    /// The parent chain ended at the host's launchd without a `launchd_sim`.
    case noSimulatorAncestor = "no_simulator_ancestor"
    /// A parent changed during the walk, or `launchd_sim` arguments were unreadable.
    case ancestorLookupFailed = "ancestor_lookup_failed"
    case unmanagedSimulator = "unmanaged_simulator"
    case ambiguousSimulator = "ambiguous_simulator"
    /// Delegated flow: the helper resolved, but the app it acts for did not.
    case appUnresolved = "app_unresolved"
    case conflictingSimulators = "conflicting_simulators"
}

public struct FlowSimulator: Codable, Equatable {
    public let udid: String
    public let deviceSet: String
    public let method: SimulatorAttributionMethod
}

public struct FlowApp: Codable, Equatable {
    /// Code-signing identifier, reported for diagnostics only. It never selects a flow.
    public let bundleId: String?
    public let executablePath: String
    public let pid: Int32
    public let pidVersion: Int32
}

public struct FlowAttribution: Equatable {
    public let attribution: FlowAttributionStatus
    public let method: SimulatorAttributionMethod
    public let simulator: FlowSimulator?
    public let app: FlowApp?
    public let reason: FlowAttributionReason?

    static func unattributed(_ reason: FlowAttributionReason) -> FlowAttribution {
        FlowAttribution(attribution: .unattributed, method: .unattributed, simulator: nil, app: nil, reason: reason)
    }

    static let conflicting = FlowAttribution(
        attribution: .conflicting,
        method: .unattributed,
        simulator: nil,
        app: nil,
        reason: .conflictingSimulators
    )
}

/// Process generation: the pid together with its pid version. A pid alone is
/// reusable and is never identity.
public struct ProcessGeneration: Codable, Hashable {
    public let pid: Int32
    public let pidVersion: Int32

    public init(pid: Int32, pidVersion: Int32) {
        self.pid = pid
        self.pidVersion = pidVersion
    }
}

public struct ProcessRecord: Equatable {
    public let pid: Int32
    public let parentPID: Int32
    /// Process start time in microseconds since the epoch. A parent can never have
    /// started after its child, which detects a parent pid reused mid-walk.
    public let startTime: UInt64
    public let executablePath: String

    public init(pid: Int32, parentPID: Int32, startTime: UInt64, executablePath: String) {
        self.pid = pid
        self.parentPID = parentPID
        self.startTime = startTime
        self.executablePath = executablePath
    }
}

/// The host process table, behind a seam so attribution is unit-tested with a fake.
public protocol ProcessTable {
    /// The pid and pid version an audit token names, or `nil` for a malformed token.
    func generation(auditToken: Data) -> ProcessGeneration?
    /// The live process for the token's exact generation; `nil` once it exited or
    /// its pid was reused.
    func process(auditToken: Data) -> ProcessRecord?
    /// Whatever process currently holds `pid`.
    func process(pid: Int32) -> ProcessRecord?
    /// `argv` of `process`, or `nil` if unreadable or the pid now names another process.
    func arguments(of process: ProcessRecord) -> [String]?
}

/// Maps a flow's audit tokens to one managed simulator, app and process
/// generation. Pure apart from `ProcessTable`; every failure is unattributed so
/// the provider fails open.
public struct SimulatorFlowResolver {
    public static let maximumAncestorDepth = 32
    static let launchdSimName = "launchd_sim"
    private static let appContainer = ["data", "Containers", "Bundle", "Application"]
    private static let deviceData = ["data"]

    private let table: ProcessTable

    public init(processTable: ProcessTable) {
        table = processTable
    }

    public func resolve(
        sourceApp: ProbeProcessIdentity?,
        sourceProcess: ProbeProcessIdentity?,
        managed: Set<ManagedSimulator>
    )
        -> FlowAttribution
    {
        if let app = sourceApp, let process = sourceProcess, app.auditToken != process.auditToken {
            return resolveDelegated(app: app, process: process, managed: managed)
        }
        guard let identity = sourceProcess ?? sourceApp else { return .unattributed(.noAuditToken) }
        switch resolve(identity, managed: managed) {
        case let .managed(attribution, _):
            return attribution
        case .unmanaged:
            return .unattributed(.unmanagedSimulator)
        case let .failed(reason):
            return .unattributed(reason)
        }
    }

    /// The helper performing the I/O (process token) may differ from the app it
    /// acts for (app token). Attribute through the app; any sign the two belong
    /// to different simulators makes the flow conflicting.
    private func resolveDelegated(
        app: ProbeProcessIdentity,
        process: ProbeProcessIdentity,
        managed: Set<ManagedSimulator>
    )
        -> FlowAttribution
    {
        let appResult = resolve(app, managed: managed)
        let processSimulator = resolve(process, managed: managed).simulator
        switch appResult {
        case let .managed(attribution, appSimulator):
            if let processSimulator, processSimulator != appSimulator { return .conflicting }
            return attribution
        case let .unmanaged(appSimulator):
            if let processSimulator, processSimulator != appSimulator { return .conflicting }
            return .unattributed(.unmanagedSimulator)
        case let .failed(reason):
            return .unattributed(processSimulator == nil ? reason : .appUnresolved)
        }
    }

    private enum TokenResult {
        case managed(FlowAttribution, ManagedSimulator)
        case unmanaged(ManagedSimulator)
        case failed(FlowAttributionReason)

        var simulator: ManagedSimulator? {
            switch self {
            case let .managed(_, simulator):
                simulator
            case let .unmanaged(simulator):
                simulator
            case .failed:
                nil
            }
        }
    }

    private enum PathMatch {
        case managed(ManagedSimulator)
        case unmanaged(ManagedSimulator)
        case ambiguous
        case noSimulatorPath
    }

    private func resolve(_ identity: ProbeProcessIdentity, managed: Set<ManagedSimulator>) -> TokenResult {
        guard let generation = table.generation(auditToken: identity.auditToken),
              let record = table.process(auditToken: identity.auditToken)
        else { return .failed(.processUnavailable) }
        let found: (ManagedSimulator, SimulatorAttributionMethod)
        switch Self.match(Self.candidates(in: record.executablePath, below: Self.appContainer), managed: managed) {
        case let .managed(simulator):
            found = (simulator, .executablePath)
        case let .unmanaged(simulator):
            return .unmanaged(simulator)
        case .ambiguous:
            return .failed(.ambiguousSimulator)
        case .noSimulatorPath:
            switch launchdSimAncestor(of: record, managed: managed) {
            case let .managed(simulator):
                found = (simulator, .launchdSimAncestor)
            case let .unmanaged(simulator):
                return .unmanaged(simulator)
            case let .failed(reason):
                return .failed(reason)
            }
        }
        return .managed(FlowAttribution(
            attribution: .attributed,
            method: found.1,
            simulator: FlowSimulator(udid: found.0.udid, deviceSet: found.0.deviceSet, method: found.1),
            app: FlowApp(
                bundleId: identity.code?.signingIdentifier,
                executablePath: record.executablePath,
                pid: generation.pid,
                pidVersion: generation.pidVersion
            ),
            reason: nil
        ), found.0)
    }

    private enum AncestorResult {
        case managed(ManagedSimulator)
        case unmanaged(ManagedSimulator)
        case failed(FlowAttributionReason)
    }

    /// Walks the parent chain to the simulator's `launchd_sim` and reads its UDID
    /// from the device-data path in its arguments.
    private func launchdSimAncestor(of record: ProcessRecord, managed: Set<ManagedSimulator>) -> AncestorResult {
        var current = record
        for _ in 0 ..< Self.maximumAncestorDepth {
            if (current.executablePath as NSString).lastPathComponent == Self.launchdSimName {
                guard let arguments = table.arguments(of: current) else { return .failed(.ancestorLookupFailed) }
                let candidates = arguments.dropFirst().flatMap { Self.candidates(in: $0, below: Self.deviceData) }
                switch Self.match(candidates, managed: managed) {
                case let .managed(simulator):
                    return .managed(simulator)
                case let .unmanaged(simulator):
                    return .unmanaged(simulator)
                case .ambiguous:
                    return .failed(.ambiguousSimulator)
                case .noSimulatorPath:
                    return .failed(.ancestorLookupFailed)
                }
            }
            // The host's launchd (pid 1) is the root: a native Mac process.
            guard current.parentPID > 1, current.parentPID != current.pid else {
                return .failed(.noSimulatorAncestor)
            }
            guard let parent = table.process(pid: current.parentPID), parent.startTime <= current.startTime else {
                return .failed(.ancestorLookupFailed)
            }
            current = parent
        }
        return .failed(.ancestorLookupFailed)
    }

    /// Every `<deviceSet>/<UUID>/<suffix…>` split of `path`.
    static func candidates(in path: String, below suffix: [String]) -> [ManagedSimulator] {
        guard path.hasPrefix("/") else { return [] }
        let components = path.split(separator: "/").map(String.init)
        return components.indices.compactMap { index in
            let tail = components[(index + 1)...]
            guard UUID(uuidString: components[index]) != nil,
                  tail.count >= suffix.count,
                  Array(tail.prefix(suffix.count)) == suffix
            else { return nil }
            return ManagedSimulator(
                deviceSet: "/" + components[..<index].joined(separator: "/"),
                udid: components[index]
            )
        }
    }

    private static func match(_ candidates: [ManagedSimulator], managed: Set<ManagedSimulator>) -> PathMatch {
        let selected = Set(candidates.filter(managed.contains))
        if selected.count > 1 { return .ambiguous }
        if let only = selected.first { return .managed(only) }
        let distinct = Set(candidates)
        if distinct.count > 1 { return .ambiguous }
        return distinct.first.map(PathMatch.unmanaged) ?? .noSimulatorPath
    }
}
