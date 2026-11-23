import Foundation

@MainActor
protocol PrototypeWebDataWiper {
    func wipe(_ identifier: UUID) async
}

extension PrototypeLibraryStore {
    @MainActor
    func resetStorage(
        _ libraryId: String,
        secureStorage: (any PrototypeSecureValueStore)? = nil,
        webDataWiper: any PrototypeWebDataWiper
    )
        async throws
    {
        try resetStorage(libraryId, secureStorage: secureStorage)
        if let id = UUID(uuidString: libraryId) { await webDataWiper.wipe(id) }
    }

    @MainActor
    func delete(_ libraryId: String, webDataWiper: any PrototypeWebDataWiper) async throws {
        try delete(libraryId)
        if let id = UUID(uuidString: libraryId) { await webDataWiper.wipe(id) }
    }
}
