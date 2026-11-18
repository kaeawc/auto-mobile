#if canImport(Security)
    import Foundation
    import Security
    #if SWIFT_PACKAGE
        @testable import AutoMobilePrototypeAgentCore
    #endif

    /// The Security boundary is injectable: tests never access the host's Keychain.
    protocol KeychainClient {
        func add(_ attributes: [String: Any]) -> OSStatus
        func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
        func copyMatching(_ query: [String: Any]) -> (OSStatus, Any?)
        func delete(_ query: [String: Any]) -> OSStatus
    }

    struct SystemKeychainClient: KeychainClient {
        func add(_ attributes: [String: Any]) -> OSStatus { SecItemAdd(attributes as CFDictionary, nil) }
        func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
            SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        }

        func copyMatching(_ query: [String: Any]) -> (OSStatus, Any?) {
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, result)
        }

        func delete(_ query: [String: Any]) -> OSStatus { SecItemDelete(query as CFDictionary) }
    }

    /// Per-prototype generic passwords. Dismissal retains them; reset (`clear_prototype_storage`)
    /// deletes them. iOS Keychain items can survive app uninstall, so uninstall alone cannot promise
    /// erasure; explicit reset is the supported deletion boundary.
    /// Biometric-bound keys are not persisted by this runtime: they remain live state only.
    struct KeychainPrototypeSecureValueStore: PrototypeSecureValueStore {
        let client: any KeychainClient
        init(client: any KeychainClient = SystemKeychainClient()) { self.client = client }

        struct Failure: Error, CustomNSError {
            let status: OSStatus
            static var errorDomain: String { NSOSStatusErrorDomain }
            var errorCode: Int { Int(status) }
        }

        private func query(id: String, key: String? = nil) -> [String: Any] {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "dev.automobile.prototype.\(id)",
                kSecAttrSynchronizable as String: false,
            ]
            if let key { query[kSecAttrAccount as String] = key }
            return query
        }

        func readAll(id: String) throws -> (entries: [String: PrototypeSecureEntry], invalidated: Set<String>) {
            var list = query(id: id)
            list[kSecMatchLimit as String] = kSecMatchLimitAll
            list[kSecReturnAttributes as String] = true
            list[kSecReturnData as String] = true
            let (status, result) = client.copyMatching(list)
            if status == errSecItemNotFound { return ([:], []) }
            // A failed enumeration cannot identify accounts safely. Preserve the items for a later read.
            guard status == errSecSuccess else { throw Failure(status: status) }
            guard let items = result as? [[String: Any]] else { throw Failure(status: errSecDecode) }
            var entries: [String: PrototypeSecureEntry] = [:]
            var invalidated: Set<String> = []
            for item in items {
                guard let key = item[kSecAttrAccount as String] as? String else { continue }
                var data = item[kSecValueData as String] as? Data
                if data == nil {
                    var read = query(id: id, key: key)
                    read[kSecReturnData as String] = true
                    let (readStatus, value) = client.copyMatching(read)
                    if readStatus == errSecItemNotFound { continue }
                    if [errSecAuthFailed, errSecDecode, errSecInteractionNotAllowed].contains(readStatus) {
                        throw Failure(status: readStatus)
                    }
                    guard readStatus == errSecSuccess else {
                        invalidated.insert(key)
                        continue
                    }
                    data = value as? Data
                }
                if let data, let entry = try? JSONDecoder().decode(PrototypeSecureEntry.self, from: data) {
                    entries[key] = entry
                } else {
                    invalidated.insert(key)
                }
            }
            return (entries, invalidated)
        }

        func write(id: String, key: String, entry: PrototypeSecureEntry) throws {
            let attributes: [String: Any] = try [
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                kSecValueData as String: JSONEncoder().encode(entry),
            ]
            let scoped = query(id: id, key: key)
            var status = client.add(scoped.merging(attributes) { _, value in value })
            if status == errSecDuplicateItem { status = client.update(scoped, attributes: attributes) }
            guard status == errSecSuccess else { throw Failure(status: status) }
        }

        func delete(id: String, key: String) throws {
            try checkedDelete(query(id: id, key: key))
        }

        func deleteAll(id: String) throws -> Int {
            // Enumerate attributes only: counting/removing items does not require decoding their values.
            var list = query(id: id)
            list[kSecMatchLimit as String] = kSecMatchLimitAll
            list[kSecReturnAttributes as String] = true
            let (status, result) = client.copyMatching(list)
            if status == errSecItemNotFound { return 0 }
            guard status == errSecSuccess else { throw Failure(status: status) }
            guard let items = result as? [[String: Any]] else { throw Failure(status: errSecDecode) }
            try checkedDelete(query(id: id))
            return items.count
        }

        private func checkedDelete(_ query: [String: Any]) throws {
            let status = client.delete(query)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
        }
    }
#endif
