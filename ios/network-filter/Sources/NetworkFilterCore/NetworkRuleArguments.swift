import Foundation

public enum NetworkRuleArgumentError: Error, Equatable, CustomStringConvertible {
    case unexpectedArgument(String)
    case missingValue(String)
    case invalidValue(flag: String, value: String)
    case missingFlag(String)
    case needsOneSimulator

    public var description: String {
        switch self {
        case let .unexpectedArgument(argument):
            "Unexpected argument '\(argument)'; use \(NetworkRuleArguments.usage)"
        case let .missingValue(flag):
            "\(flag) needs a value"
        case let .invalidValue(flag, value):
            "Invalid value '\(value)' for \(flag)"
        case let .missingFlag(flag):
            "\(flag) is required"
        case .needsOneSimulator:
            "Exactly one --managed <device-set-path> <udid> pair names the rule's simulator"
        }
    }
}

/// Parses `apply|reset|renew --managed <device-set-path> <udid> --bundle-id <id>
/// --owner <session> --owner-generation <n> --revision <n> [--lease-ms <n>]`.
/// `--lease-ms` is required for `apply` and `renew` and rejected for `reset`.
public enum NetworkRuleArguments {
    public static let usage = "--managed <device-set-path> <udid> --bundle-id <id> --owner <session> " +
        "--owner-generation <n> --revision <n> [--lease-ms <n>]"

    public static func parse(
        _ kind: NetworkRuleCommandKind,
        _ arguments: [String],
        canonicalize: (String) -> String
    )
        throws -> NetworkRuleCommand
    {
        let (simulator, values) = try split(kind, arguments, canonicalize: canonicalize)
        let bundleId = try required("--bundle-id", values)
        guard let target = NetworkRuleTarget(simulator: simulator, bundleId: bundleId) else {
            throw NetworkRuleArgumentError.invalidValue(flag: "--bundle-id", value: bundleId)
        }
        let owner = try required("--owner", values)
        guard let ownership = try NetworkRuleOwnership(
            owner: owner,
            ownerGeneration: number("--owner-generation", values),
            revision: number("--revision", values)
        ) else {
            throw NetworkRuleArgumentError.invalidValue(flag: "--owner", value: owner)
        }
        return try NetworkRuleCommand(
            kind: kind,
            target: target,
            ownership: ownership,
            condition: kind == .apply ? .offline : nil,
            leaseMilliseconds: kind == .reset ? nil : number("--lease-ms", values)
        )
    }

    private static func split(
        _ kind: NetworkRuleCommandKind,
        _ arguments: [String],
        canonicalize: (String) -> String
    )
        throws -> (ManagedSimulator, [String: String])
    {
        var remaining = arguments[...]
        var values: [String: String] = [:]
        var simulators: [ManagedSimulator] = []
        var valueFlags: Set = ["--bundle-id", "--owner", "--owner-generation", "--revision"]
        if kind != .reset {
            valueFlags.insert("--lease-ms")
        }
        while let flag = remaining.popFirst() {
            if flag == "--managed" {
                guard let deviceSet = remaining.popFirst(), let udid = remaining.popFirst() else {
                    throw NetworkRuleArgumentError.missingValue(flag)
                }
                guard let simulator = ManagedSimulator(deviceSet: canonicalize(deviceSet), udid: udid) else {
                    throw NetworkRuleArgumentError.invalidValue(flag: flag, value: "\(deviceSet) \(udid)")
                }
                simulators.append(simulator)
                continue
            }
            guard valueFlags.contains(flag), values[flag] == nil else {
                throw NetworkRuleArgumentError.unexpectedArgument(flag)
            }
            guard let value = remaining.popFirst() else { throw NetworkRuleArgumentError.missingValue(flag) }
            values[flag] = value
        }
        guard simulators.count == 1, let simulator = simulators.first else {
            throw NetworkRuleArgumentError.needsOneSimulator
        }
        return (simulator, values)
    }

    private static func required(_ flag: String, _ values: [String: String]) throws -> String {
        guard let value = values[flag] else { throw NetworkRuleArgumentError.missingFlag(flag) }
        return value
    }

    private static func number(_ flag: String, _ values: [String: String]) throws -> UInt64 {
        let value = try required(flag, values)
        guard let parsed = UInt64(value) else { throw NetworkRuleArgumentError.invalidValue(flag: flag, value: value) }
        return parsed
    }
}
