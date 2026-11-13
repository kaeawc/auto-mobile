import Foundation

/// iOS half of a `schemas/prototype-platform-permissions.json` entry (#14297). A nil `simctlService`
/// means a simulator cannot grant or deny the permission.
public struct PrototypeIosPermissionMapping: Decodable, Equatable, Sendable {
    public let usageKey: String?
    public let simctlService: String?
}

/// Android half of an entry: manifest permissions and how the host grants them
/// (`pmGrant`, `notifications` or `none`).
public struct PrototypeAndroidPermissionMapping: Decodable, Equatable, Sendable {
    public let manifest: [String]
    public let grant: String
}

public struct PrototypePermissionMapping: Decodable, Equatable, Sendable {
    public let android: PrototypeAndroidPermissionMapping
    public let ios: PrototypeIosPermissionMapping
}

/// Reader for the generated copy of the canonical mapping TypeScript and Kotlin also read.
public enum PrototypePlatformPermissions {
    private static let mapping: [String: PrototypePermissionMapping] = {
        guard let decoded = try? JSONDecoder().decode(
            [String: PrototypePermissionMapping].self, from: Data(prototypePlatformPermissionsData.utf8)
        )
        else { preconditionFailure("Embedded platform permission mapping is unavailable") }
        return decoded
    }()

    /// Canonical permission names, in spec-contract order.
    public static let names: [String] = {
        guard let contract = try? JSONDecoder().decode(JSONValue.self, from: Data(prototypeSpecContractData.utf8)),
              case let .array(values)? = contract.objectFields?["definitions"]?.objectFields?["platformPermission"]?
              .objectFields?["fields"]?.objectFields?["name"]?.objectFields?["rule"]?.objectFields?["values"]
        else { preconditionFailure("Embedded structural contract is unavailable") }
        return values.compactMap { if case let .string(name) = $0 { name } else { nil } }
    }()

    public static func mapping(for name: String) -> PrototypePermissionMapping? { mapping[name] }
}
