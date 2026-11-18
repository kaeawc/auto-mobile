import Foundation

struct PrototypeSecureEntry: Codable, Equatable {
    let version: Int
    let value: String

    private enum CodingKeys: String, CodingKey {
        case version = "v"
        case value
    }
}

/// Synchronous device-local storage; keys use the `state:<name>` storage-key form.
protocol PrototypeSecureValueStore {
    func readAll(id: String) throws -> (entries: [String: PrototypeSecureEntry], invalidated: Set<String>)
    func write(id: String, key: String, entry: PrototypeSecureEntry) throws
    func delete(id: String, key: String) throws
    func deleteAll(id: String) throws -> Int
}

/// Membership advertises persistence support; secure storage has no platform calls.
@MainActor
final class PrototypeSecureStorageModule: PrototypePlatformModule {
    let name = "secureStorage"
    let capability = "prototype_platform_secureStorage_v1"
    let store: any PrototypeSecureValueStore
    private var locked = false
    var state: [String: JSONValue] { ["locked": .bool(locked)] }
    var events: AsyncStream<PlatformEvent> { AsyncStream { $0.finish() } }

    init(store: any PrototypeSecureValueStore) { self.store = store }
    func availability() -> PlatformAvailability { .ready }
    func call(_: PlatformCall) async -> PlatformCallResult {
        .failure(.unsupported, "Secure storage has no platform calls")
    }

    func restored(locked keys: [String]) { locked = !keys.isEmpty }
    func stop() {}
}
