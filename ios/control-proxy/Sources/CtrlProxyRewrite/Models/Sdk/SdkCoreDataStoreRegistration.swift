import Foundation

/// A Core Data store the in-app SDK has registered for inspection. Ported from the
/// reference `SdkDatabaseClient.swift`; immutable value type, so `Sendable`.
public struct SdkCoreDataStoreRegistration: Codable, Equatable, Sendable {
    public let identifier: String
    public let modelVersion: String?
    public let entities: [String]

    public init(identifier: String, modelVersion: String?, entities: [String]) {
        self.identifier = identifier
        self.modelVersion = modelVersion
        self.entities = entities
    }
}
