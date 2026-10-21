import Foundation

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
