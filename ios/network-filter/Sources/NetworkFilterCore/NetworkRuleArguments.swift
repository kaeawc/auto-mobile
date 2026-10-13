import Foundation

public enum NetworkRuleArgumentError: Error, Equatable, CustomStringConvertible {
    case unexpectedArgument(String, version: Int = ControllerContract.defaultVersion)
    case missingValue(String)
    case invalidValue(flag: String, value: String)
    case missingFlag(String)
    case needsOneSimulator
    case shapingNeedsVersionFour

    public var description: String {
        switch self {
        case let .unexpectedArgument(argument, version):
            "Unexpected argument '\(argument)'; use \(NetworkRuleArguments.usage(for: version))"
        case let .missingValue(flag):
            "\(flag) needs a value"
        case let .invalidValue(flag, value):
            "Invalid value '\(value)' for \(flag)"
        case let .missingFlag(flag):
            "\(flag) is required"
        case .shapingNeedsVersionFour:
            "Shaping flags require --contract-version 4."
        case .needsOneSimulator:
            "Exactly one --managed <device-set-path> <udid> pair names the rule's simulator"
        }
    }
}

/// Parses `apply|reset|renew --managed <device-set-path> <udid> --bundle-id <id>
/// --owner <session> --owner-generation <n> --revision <n> [--lease-ms <n>]`.
/// `--lease-ms` is required for `apply` and `renew` and rejected for `reset`.
public enum NetworkRuleArguments {
    public static let legacyUsage = "--managed <device-set-path> <udid> --bundle-id <id> --owner <session> " +
        "--owner-generation <n> --revision <n> [--lease-ms <n>]"

    public static let shapingUsage =
        "[--delay-ms <n>] [--down-kbps <n>] [--up-kbps <n>] [--packet-loss-percent <x>] (--contract-version 4)"
    public static let usage = legacyUsage + " " + shapingUsage

    /// Version-3 error text stays byte-compatible with the pre-negotiation controller.
    public static func usage(for version: Int) -> String {
        version == 3 ? legacyUsage : usage
    }

    private static let shapingFlags: Set<String> = [
        "--delay-ms", "--down-kbps", "--up-kbps", "--packet-loss-percent",
    ]

    public static func parse(
        _ kind: NetworkRuleCommandKind,
        _ arguments: [String],
        version: Int = ControllerContract.defaultVersion,
        canonicalize: (String) -> String
    )
        throws -> NetworkRuleCommand
    {
        let (simulator, values) = try split(kind, arguments, version: version, canonicalize: canonicalize)
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
            condition: kind == .apply ? condition(values) : nil,
            leaseMilliseconds: kind == .reset ? nil : number("--lease-ms", values)
        )
    }

    private static func split(
        _ kind: NetworkRuleCommandKind,
        _ arguments: [String],
        version: Int,
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
        if kind == .apply, version == 4 { valueFlags.formUnion(shapingFlags) }
        while let flag = remaining.popFirst() {
            if kind == .apply, version == 3, shapingFlags.contains(flag) {
                throw NetworkRuleArgumentError.shapingNeedsVersionFour
            }
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
                throw NetworkRuleArgumentError.unexpectedArgument(flag, version: version)
            }
            guard let value = remaining.popFirst() else { throw NetworkRuleArgumentError.missingValue(flag) }
            values[flag] = value
        }
        guard simulators.count == 1, let simulator = simulators.first else {
            throw NetworkRuleArgumentError.needsOneSimulator
        }
        return (simulator, values)
    }

    private static func condition(_ values: [String: String]) throws -> NetworkRuleCommandCondition {
        guard !shapingFlags.isDisjoint(with: values.keys) else { return .offline }
        let lossFlag = "--packet-loss-percent"
        let lossText = values[lossFlag] ?? "0"
        guard let loss = Double(lossText), loss.isFinite else {
            throw NetworkRuleArgumentError.invalidValue(flag: lossFlag, value: lossText)
        }
        return try .shaped(ShapingRequest(
            delayMilliseconds: values["--delay-ms"] == nil ? 0 : number("--delay-ms", values),
            downloadKilobitsPerSecond: values["--down-kbps"] == nil ? 0 : number("--down-kbps", values),
            uploadKilobitsPerSecond: values["--up-kbps"] == nil ? 0 : number("--up-kbps", values),
            packetLossPercent: loss
        ))
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
