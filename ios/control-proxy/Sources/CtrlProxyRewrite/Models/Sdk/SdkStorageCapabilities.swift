import Foundation

/// The in-app SDK's declared storage-inspection capabilities. Ported from the
/// reference `SdkDatabaseClient.swift`; immutable value type, so `Sendable`.
public struct SdkStorageCapabilities: Codable, Equatable, Sendable {
    public let readOnly: Bool
    public let mutationAuthorized: Bool
    public let registeredAppGroupSuites: [String]
    public let coreDataStores: [SdkCoreDataStoreRegistration]
    public let unavailableStores: [String]

    public init(
        readOnly: Bool,
        mutationAuthorized: Bool,
        registeredAppGroupSuites: [String],
        coreDataStores: [SdkCoreDataStoreRegistration],
        unavailableStores: [String]
    ) {
        self.readOnly = readOnly
        self.mutationAuthorized = mutationAuthorized
        self.registeredAppGroupSuites = registeredAppGroupSuites
        self.coreDataStores = coreDataStores
        self.unavailableStores = unavailableStores
    }
}
