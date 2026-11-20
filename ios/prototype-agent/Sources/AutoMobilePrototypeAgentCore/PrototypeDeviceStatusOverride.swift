import Foundation

enum DeviceStatusMode: String, Decodable {
    case real, fake
}

/// Pure simulate override. A missing shown value means no reading or seed has arrived yet.
struct DeviceStatusOverride {
    let platform: String
    private(set) var mode: DeviceStatusMode = .real
    private(set) var shown: [String: JSONValue]?
    private var real: [String: JSONValue]?

    init(platform: String) { self.platform = platform }

    mutating func reading(_ values: [String: JSONValue]) {
        real = values
        if mode == .real { shown = values }
    }

    mutating func mode(_ next: DeviceStatusMode) {
        guard next != mode else { return }
        mode = next
        if next == .real { shown = real ?? shown.map { _ in [:] } }
    }

    /// Validate the entire merge before publishing it, so refusals leave the override untouched.
    mutating func seed(module: String, _ seed: [String: JSONValue]) throws {
        guard mode == .fake else {
            throw PrototypeContractValidator.invalid("seed", "simulate state needs \(module) in fake platformMode")
        }
        let state = PrototypeContractValidator.platformModules[module]?.objectFields?["state"]?.objectFields ?? [:]
        var values = shown ?? [:]
        for key in PrototypeContractValidator.sorted(seed.keys) {
            guard let value = seed[key] else { continue }
            let path = "seed.\(key)"
            guard let entry = state[key]?.objectFields else {
                throw PrototypeContractValidator.invalid(path, "/platform/\(module) has no key \(key)")
            }
            guard case let .array(platforms)? = entry["platforms"], platforms.contains(.string(platform)) else {
                throw PrototypeContractValidator.invalid(
                    path,
                    "/platform/\(module)/\(key) is not reported on \(platform)"
                )
            }
            if value == .null {
                values[key] = nil
            } else {
                guard let rule = entry["value"] else {
                    throw PrototypeContractValidator.invalid(path, "/platform/\(module)/\(key) has no value rule")
                }
                try PrototypeContractValidator.validateValue(value, rule: rule, path: path)
                values[key] = value
            }
        }
        shown = values
    }
}
