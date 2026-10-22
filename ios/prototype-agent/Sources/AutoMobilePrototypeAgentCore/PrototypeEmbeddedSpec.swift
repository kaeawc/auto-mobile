import Foundation

/// A failure that prevents the entire embedded screen from being presented.
/// This enum may gain cases; include a default branch when switching over it.
public enum PrototypeLoadError: Error, Equatable, Sendable, LocalizedError {
    /// A validation diagnostic using the shared structural contract's JSON paths.
    case invalidSpec(path: String, message: String)
    /// Required capabilities absent from `AutoMobilePrototypeCapabilities.supported`, sorted by name.
    case unsupportedCapabilities([String])

    /// A visible, actionable diagnostic for the embedding app's error UI.
    public var errorDescription: String? {
        switch self {
        case let .invalidSpec(path, message): "\(path): \(message)"
        case let .unsupportedCapabilities(missing): "Unsupported prototype capabilities: " + missing
            .joined(separator: ", ")
        }
    }

    /// Validates in-memory spec bytes without starting a renderer, storage, or networking.
    public static func validate(spec: Data) throws {
        _ = try PrototypeEmbeddedSpec.load(data: spec)
    }
}

enum PrototypeEmbeddedSpec {
    static func load(
        data: Data, supported: [String] = AutoMobilePrototypeCapabilities.supported
    )
        throws -> (spec: PrototypeSpec, bytes: Int)
    {
        try PrototypeSpecStrictValidator.validate(data: data)
        switch PrototypeViewerSpecLoader.load(data: data) {
        case let .invalid(path, message): throw PrototypeLoadError.invalidSpec(path: path, message: message)
        case let .loaded(spec, bytes):
            let value = try JSONDecoder().decode(JSONValue.self, from: PrototypeStrictJSON.prepare(data))
            let required = PrototypeStrictCapabilities.required(value.objectFields ?? [:], includeAgentGates: true)
            let missing = required.subtracting(supported).sorted()
            guard missing.isEmpty else { throw PrototypeLoadError.unsupportedCapabilities(missing) }
            return (spec, bytes)
        default:
            // The Data loader has only loaded/invalid outcomes; saved-layout outcomes stay file-only.
            throw PrototypeLoadError.invalidSpec(path: "$", message: "Expected prototype JSON")
        }
    }
}
