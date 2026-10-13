import Foundation

/// The JSON contract between the AutoMobile daemon and `network-filter-controller`.
///
/// The daemon runs the installed controller as a subprocess and parses the one
/// line of JSON it prints. Bump `version` whenever a field changes meaning or a
/// required field is added or removed; the daemon rejects any other version.
/// The nested `snapshot` carries the provider's own version. Version 2 shipped
/// per-simulator attribution (#10589), where `status` and `snapshot` take
/// repeatable `--managed <device-set> <udid>` pairs. Version 3 adds the leased
/// per-app `apply`, `reset` and `renew` commands, the `rule` result field, and
/// the snapshot's `rules` (#10264). Version 4 carries shaping configuration;
/// invocations without negotiation still use version 3 for installed hosts.
public enum ControllerContract {
    public static let version = 4
    public static let supportedVersions = [3, 4]
    public static let defaultVersion = 3
    public static let commands = ["activate", "status", "snapshot"] + NetworkRuleCommandKind.allCases.map(\.rawValue)
}

/// Every state the controller reports. The raw values are the wire format.
public enum ControllerState: String, Codable, CaseIterable {
    /// The app or provider is not signed and provisioned, or not run from /Applications.
    case installationRequired = "installation_required"
    /// The system extension or filter configuration waits for approval, or a restart.
    case approvalRequired = "approval_required"
    /// Activation or the authenticated read-back failed or timed out.
    case unavailable
    /// The allow-only provider replied over authenticated XPC.
    case ready
}

public struct ControllerResult: Codable {
    public let version: Int
    public let state: ControllerState
    public let detail: String
    public let snapshot: ProbeSnapshot?
    /// `apply`, `reset` and `renew`: the provider's definitive answer. Absent when
    /// the command's outcome is unknown (any state but `ready`); the host then
    /// reconciles with `status`.
    public let rule: NetworkRuleResult?

    public init(
        state: ControllerState,
        detail: String,
        snapshot: ProbeSnapshot? = nil,
        rule: NetworkRuleResult? = nil,
        version: Int = ControllerContract.defaultVersion
    ) {
        self.version = version
        self.state = state
        self.detail = detail
        self.snapshot = snapshot
        self.rule = rule
    }

    /// One line of JSON, without the trailing newline the controller writes.
    public func encodedLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}

/// Only a leading negotiation pair is stripped before command-specific parsing,
/// preserving legacy flag values and keeping every ending in the requested version.
public struct ControllerInvocation: Equatable {
    public let command: String
    public let version: Int
    public let arguments: [String]

    public static func parse(_ arguments: [String]) throws -> ControllerInvocation {
        guard let command = arguments.first else { throw ControllerInvocationError.invalidCommand() }
        var remaining = Array(arguments.dropFirst())
        var version = ControllerContract.defaultVersion
        if remaining.first == "--contract-version" {
            guard remaining.count >= 2 else { throw ControllerInvocationError.invalidVersion }
            switch remaining[1] {
            case "3": version = 3
            case "4": version = 4
            default: throw ControllerInvocationError.invalidVersion
            }
            remaining.removeFirst(2)
        }
        guard ControllerContract.commands.contains(command)
        else { throw ControllerInvocationError.invalidCommand(version: version) }
        // Legacy activate ignores arguments; version 4 makes its argument errors explicit.
        if command == "activate", version == 4, let argument = remaining.first {
            throw ControllerInvocationError.unexpectedActivateArgument(argument)
        }
        return ControllerInvocation(command: command, version: version, arguments: remaining)
    }
}

public enum ControllerInvocationError: Error, Equatable, CustomStringConvertible {
    case invalidVersion
    case unexpectedActivateArgument(String)
    case invalidCommand(version: Int = ControllerContract.defaultVersion)

    public var description: String {
        switch self {
        case let .unexpectedActivateArgument(argument):
            "Unexpected argument '\(argument)'; use activate [--contract-version <3|4>]"
        case .invalidVersion:
            "Invalid or repeated --contract-version. Supported contract versions: 3, 4."
        case let .invalidCommand(version):
            "Usage: network-filter-controller \(ControllerContract.commands.joined(separator: "|"))"
                + " [--managed <device-set-path> <udid>]... (status|snapshot)"
                + " | apply|reset|renew \(NetworkRuleArguments.usage(for: version))"
        }
    }

    public var result: ControllerResult {
        let version: Int
        switch self {
        case .invalidVersion, .unexpectedActivateArgument: version = ControllerContract.version
        case let .invalidCommand(requested): version = requested
        }
        return ControllerResult(state: .unavailable, detail: description, version: version)
    }
}
