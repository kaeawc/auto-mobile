import AutoMobileSDK
import Foundation

/// The storage registration the scenario applied (#5164 phase D). The harness derives the
/// expected Keychain capability and store states from it
/// (`scripts/ios/sdk-contract/storageSlice.ts`).
struct StorageRegistration: Encodable, Equatable, Sendable {
    struct KeychainEntry: Encodable, Equatable, Sendable {
        let service: String
        let account: String
        let accessGroup: String
    }

    struct CoreDataStore: Encodable, Equatable, Sendable {
        let identifier: String
        let queryable: Bool
        let appGroup: String?
        let coordination: String?
    }

    let allowKeychainDeletion: Bool
    let keychainEntries: [KeychainEntry]
    let uncoordinatedSuites: [String]
    let hostCoordinatedSuites: [String]
    let coreDataStores: [CoreDataStore]
    /// Whether the scenario wrote the secret into the first suite, which no capability may carry.
    let secretWritten: Bool
}

/// Storage slice (#5164 phase D). `storage` registers two app-group suites (one host-coordinated),
/// two app-private (one queryable) and a shared Core Data store, and Keychain deletion for one exact item, then
/// writes a secret into a registered suite. `storage-default` applies the default configuration,
/// which registers nothing and leaves Keychain deletion off. The SDK keeps serving the
/// registration until the harness has read the MCP storage capability resource.
enum SdkContractStorageScenario {
    static let registeredScenario = "storage"
    static let defaultScenario = "storage-default"
    /// Must never appear in any storage capability (`FORBIDDEN_STORAGE_SUBSTRINGS`).
    static let secret = "contract-storage-secret"

    static func run(
        scenario: String,
        runId: String,
        inspector: DatabaseInspector = .shared
    )
        throws -> StorageRegistration
    {
        guard scenario == registeredScenario else {
            inspector.configure(StorageInspectionConfiguration())
            return StorageRegistration(
                allowKeychainDeletion: false,
                keychainEntries: [],
                uncoordinatedSuites: [],
                hostCoordinatedSuites: [],
                coreDataStores: [],
                secretWritten: false
            )
        }
        let uncoordinated = "group.dev.jasonpearson.automobile.contract.\(runId)"
        let coordinated = "group.dev.jasonpearson.automobile.contract.coordinated.\(runId)"
        let entry = KeychainDeletionEntry(
            service: "dev.jasonpearson.automobile.contract",
            account: "contract-\(runId)",
            accessGroup: "dev.jasonpearson.automobile.contract"
        )
        let privateStore = CoreDataStoreRegistration(identifier: "ContractPrivate-\(runId)", entities: ["Item"])
        let sharedStore = CoreDataStoreRegistration(
            identifier: "ContractShared-\(runId)",
            entities: ["Item"],
            appGroup: uncoordinated,
            coordination: .hostCoordinated
        )
        inspector.configure(StorageInspectionConfiguration(
            allowKeychainDeletion: true,
            allowedKeychainDeletionEntries: [entry]
        ))
        inspector.registerAppGroupSuite(uncoordinated, coordination: .uncoordinated)
        inspector.registerAppGroupSuite(coordinated, coordination: .hostCoordinated)
        inspector.registerCoreDataStore(privateStore)
        inspector.registerCoreDataStore(sharedStore)
        let queryIdentifier = "ContractQuery-\(runId)"
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else {
            throw PlaygroundDatabaseFixtureError.applicationSupportDirectoryUnavailable
        }
        let directory = support.appendingPathComponent("SdkContract", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let queryFixture = try PlaygroundCoreDataFixture(
            storeURL: directory.appendingPathComponent("\(queryIdentifier).sqlite"),
            identifier: queryIdentifier
        )
        queryFixture.register(with: inspector)
        let defaults = UserDefaults(suiteName: uncoordinated)
        defaults?.set(secret, forKey: "contract.token")
        return StorageRegistration(
            allowKeychainDeletion: true,
            keychainEntries: [
                .init(service: entry.service, account: entry.account, accessGroup: entry.accessGroup),
            ],
            uncoordinatedSuites: [uncoordinated],
            hostCoordinatedSuites: [coordinated],
            coreDataStores: [
                .init(identifier: privateStore.identifier, queryable: false, appGroup: nil, coordination: nil),
                .init(
                    identifier: sharedStore.identifier,
                    queryable: false,
                    appGroup: uncoordinated,
                    coordination: "host_coordinated"
                ),
                .init(identifier: queryIdentifier, queryable: true, appGroup: nil, coordination: nil),
            ],
            secretWritten: defaults != nil
        )
    }
}
