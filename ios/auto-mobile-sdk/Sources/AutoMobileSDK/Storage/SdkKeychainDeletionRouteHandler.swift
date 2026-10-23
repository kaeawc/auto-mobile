#if DEBUG && !os(watchOS)
    import AutoMobileSdkWire
    import Foundation
    import LocalAuthentication
    import Security

    /// A narrow seam: tests supply a fake and never call Security.framework.
    protocol KeychainDeleting {
        func delete(query: [CFString: Any]) -> OSStatus
    }

    struct SystemKeychainDeleter: KeychainDeleting {
        func delete(query: [CFString: Any]) -> OSStatus {
            SecItemDelete(query as CFDictionary)
        }
    }

    struct SdkKeychainDeletionRouteHandler {
        private let authenticationContext: () -> LAContext
        private let keychain: any KeychainDeleting
        private let bundleId: () -> String?
        private let currentSessionId: () -> String?
        private let configuration: () -> StorageInspectionConfiguration
        private let canMutate: (String?, String?, String?) -> Bool

        init(
            keychain: any KeychainDeleting = SystemKeychainDeleter(),
            authenticationContext: @escaping () -> LAContext = { LAContext() },
            bundleId: @escaping () -> String? = { Bundle.main.bundleIdentifier },
            currentSessionId: @escaping () -> String? = { AutoMobileSDK.shared.currentSessionId() },
            configuration: @escaping () -> StorageInspectionConfiguration = {
                DatabaseInspector.shared.inspectionConfiguration
            },
            canMutate: @escaping (String?, String?, String?) -> Bool = {
                DatabaseInspector.shared.canMutate(sessionId: $0, currentSessionId: $1, mutationToken: $2)
            }
        ) {
            self.authenticationContext = authenticationContext
            self.keychain = keychain
            self.bundleId = bundleId
            self.currentSessionId = currentSessionId
            self.configuration = configuration
            self.canMutate = canMutate
        }

        func handle(body: Data) -> SdkRouteResponse {
            guard let request = try? JSONDecoder().decode(KeychainDeleteRequest.self, from: body) else {
                return result("invalid_selector", status: 400)
            }
            let selector = request.selector
            guard selector.itemClass == "genericPassword" else {
                return result("unsupported_item_type", status: 400)
            }
            guard !selector.service.isEmpty, !selector.account.isEmpty, !selector.accessGroup.isEmpty else {
                return result("invalid_selector", status: 400)
            }
            guard request.confirm else { return result("confirmation_required", status: 400) }
            guard let appId = bundleId(), appId == request.appId else {
                return result("app_id_mismatch", status: 409)
            }
            let policy = configuration()
            // Match on raw UTF-8 bytes: Swift String equality folds canonically equivalent
            // spellings, but the Keychain compares bytes, so a differently normalized
            // request must not reach an item the host never allowlisted. The query and the
            // reported scope are built from the allowlisted entry, not the request.
            guard policy.allowKeychainDeletion,
                  let entry = policy.allowedKeychainDeletionEntries.first(where: {
                      $0.service.utf8.elementsEqual(selector.service.utf8)
                          && $0.account.utf8.elementsEqual(selector.account.utf8)
                          && $0.accessGroup.utf8.elementsEqual(selector.accessGroup.utf8)
                  })
            else {
                return result("scope_not_authorized", status: 403)
            }
            guard canMutate(request.sessionId, currentSessionId(), request.mutationToken) else {
                return result("mutation_not_authorized", status: 403)
            }

            return delete(KeychainItemSelector(
                itemClass: selector.itemClass,
                service: entry.service,
                account: entry.account,
                accessGroup: entry.accessGroup
            ))
        }

        private func delete(_ selector: KeychainItemSelector) -> SdkRouteResponse {
            // All four exact attributes are mandatory. No wildcard or match-limit query.
            let authenticationContext = authenticationContext()
            authenticationContext.interactionNotAllowed = true
            let query: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: selector.service,
                kSecAttrAccount: selector.account,
                kSecAttrAccessGroup: selector.accessGroup,
                // On macOS the legacy file keychain ignores kSecAttrAccessGroup; the data
                // protection keychain honors it, so the group stays part of the match.
                kSecUseDataProtectionKeychain: true,
                kSecUseAuthenticationContext: authenticationContext,
            ]
            switch keychain.delete(query: query) {
            case errSecSuccess: return result("deleted", deletedScope: selector)
            case errSecItemNotFound: return result("not_found")
            case errSecInteractionNotAllowed, errSecNotAvailable: return result("protected_data_unavailable")
            case errSecAuthFailed, errSecUserCanceled: return result("user_auth_required")
            case errSecMissingEntitlement: return result("entitlement_denied")
            default: return result("keychain_error", status: 500)
            }
        }

        private func result(
            _ outcome: String,
            status: Int = 200,
            deletedScope: KeychainItemSelector? = nil
        )
            -> SdkRouteResponse
        {
            let payload = KeychainDeleteOutcome(outcome: outcome, deletedScope: deletedScope)
            let body = (try? JSONEncoder().encode(payload)) ?? Data()
            return SdkRouteResponse(statusCode: status, body: body)
        }
    }
#endif
