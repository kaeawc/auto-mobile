import AutoMobileSdkWire
import Foundation

public struct SdkStorageCapabilities: Codable, Equatable, Sendable {
    public let readOnly: Bool
    public let mutationAuthorized: Bool
    public let registeredAppGroupSuites: [String]
    public let coreDataStores: [SdkCoreDataStoreRegistration]
    public let unavailableStores: [String]
    /// Store sharing and coordination states (#5161). Nil from SDKs that predate them.
    public let stores: [StorageStoreState]?
    /// Keychain capability (#5161). Nil from SDKs that predate it.
    public let keychain: KeychainCapability?

    public init(
        readOnly: Bool,
        mutationAuthorized: Bool,
        registeredAppGroupSuites: [String],
        coreDataStores: [SdkCoreDataStoreRegistration],
        unavailableStores: [String],
        stores: [StorageStoreState]? = nil,
        keychain: KeychainCapability? = nil
    ) {
        self.readOnly = readOnly
        self.mutationAuthorized = mutationAuthorized
        self.registeredAppGroupSuites = registeredAppGroupSuites
        self.coreDataStores = coreDataStores
        self.unavailableStores = unavailableStores
        self.stores = stores
        self.keychain = keychain
    }
}
