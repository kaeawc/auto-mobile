#if DEBUG && !os(watchOS)
    @testable import AutoMobileSDK
    import AutoMobileSdkWire
    import Foundation
    import LocalAuthentication
    import Security
    import XCTest

    // macOS may invalidate real contexts in a sandbox. Record the no-interaction
    // setting without contacting authentication services during this unit test.
    private final class FakeAuthenticationContext: LAContext {
        override var interactionNotAllowed: Bool {
            get { disallowInteraction }
            set { disallowInteraction = newValue }
        }

        private var disallowInteraction = false
    }

    private final class FakeKeychainDeleter: KeychainDeleting {
        var status: OSStatus = errSecSuccess
        var queries: [[CFString: Any]] = []

        func delete(query: [CFString: Any]) -> OSStatus {
            queries.append(query)
            return status
        }
    }

    final class SdkKeychainDeletionTests: XCTestCase {
        private let selector = KeychainItemSelector(
            itemClass: "genericPassword",
            service: "test.service",
            account: "fixture",
            accessGroup: "TEAMID.test.app"
        )

        private func response(
            selector: KeychainItemSelector? = nil,
            confirm: Bool = true,
            appId: String = "test.app",
            allowed: Bool = true,
            authorized: Bool = true,
            status: OSStatus = errSecSuccess
        )
            throws -> (KeychainDeleteOutcome, FakeKeychainDeleter)
        {
            let fake = FakeKeychainDeleter()
            fake.status = status
            let selected = selector ?? self.selector
            let policy = StorageInspectionConfiguration(
                allowMutations: true,
                allowKeychainDeletion: allowed,
                allowedKeychainDeletionEntries: [
                    KeychainDeletionEntry(service: "test.service", account: "fixture", accessGroup: "TEAMID.test.app"),
                    KeychainDeletionEntry(service: "other.service", account: "other", accessGroup: "TEAMID.other.app"),
                ]
            )
            let handler = SdkKeychainDeletionRouteHandler(
                keychain: fake,
                authenticationContext: { FakeAuthenticationContext() },
                bundleId: { "test.app" },
                currentSessionId: { "active-session" },
                configuration: { policy },
                canMutate: { id, current, token in authorized && id == current && id != nil && token == "launch-token" }
            )
            let body = try JSONEncoder().encode(TestRequest(
                appId: appId, sessionId: "active-session", confirm: confirm, selector: selected
            ))
            let route = handler.handle(body: body)
            return try (JSONDecoder().decode(KeychainDeleteOutcome.self, from: route.body), fake)
        }

        func testDeletesExactFixtureItemWithoutReadingValue() throws {
            let (result, fake) = try response()
            XCTAssertEqual(result.outcome, "deleted")
            XCTAssertEqual(result.deletedScope, selector)
            XCTAssertEqual(fake.queries.count, 1)
            XCTAssertEqual(fake.queries[0][kSecAttrService] as? String, selector.service)
            XCTAssertEqual(fake.queries[0][kSecAttrAccount] as? String, selector.account)
            XCTAssertEqual(fake.queries[0][kSecAttrAccessGroup] as? String, selector.accessGroup)
            XCTAssertNil(fake.queries[0][kSecMatchLimit])
            XCTAssertNil(fake.queries[0][kSecReturnData])
            XCTAssertNil(fake.queries[0][kSecReturnAttributes])
            XCTAssertEqual(fake.queries[0].count, 6)
            XCTAssertEqual(fake.queries[0][kSecUseDataProtectionKeychain] as? Bool, true)
            XCTAssertEqual(fake.queries[0][kSecClass] as? String, kSecClassGenericPassword as String)
            XCTAssertEqual((fake.queries[0][kSecUseAuthenticationContext] as? LAContext)?.interactionNotAllowed, true)
        }

        func testRejectsEachEmptySelectorPart() throws {
            for emptyPart in ["service", "account", "accessGroup"] {
                let selected = KeychainItemSelector(
                    itemClass: "genericPassword",
                    service: emptyPart == "service" ? "" : selector.service,
                    account: emptyPart == "account" ? "" : selector.account,
                    accessGroup: emptyPart == "accessGroup" ? "" : selector.accessGroup
                )
                let (result, fake) = try response(selector: selected)
                XCTAssertEqual(result.outcome, "invalid_selector")
                XCTAssertTrue(fake.queries.isEmpty)
            }
        }

        func testUsesDatabaseMutationGateForHostSessionAndTokenAuthorization() throws {
            let inspector = DatabaseInspector.shared
            let policy = StorageInspectionConfiguration(
                allowMutations: true,
                allowKeychainDeletion: true,
                allowedKeychainDeletionEntries: [KeychainDeletionEntry(
                    service: selector.service,
                    account: selector.account,
                    accessGroup: selector.accessGroup
                )]
            )
            inspector.configure(policy)
            defer {
                inspector.configure(StorageInspectionConfiguration())
                inspector.authorizeHostMutations(false)
                inspector.authorizeSessionMutations(sessionId: nil)
                inspector.authorizeMutationToken("")
            }
            let fake = FakeKeychainDeleter()
            let handler = SdkKeychainDeletionRouteHandler(
                keychain: fake,
                authenticationContext: { FakeAuthenticationContext() },
                bundleId: { "test.app" },
                currentSessionId: { "active" }
            )
            func send(session: String?, token: String?) throws -> String {
                let request = KeychainDeleteRequest(
                    appId: "test.app",
                    sessionId: session,
                    mutationToken: token,
                    confirm: true,
                    selector: selector
                )
                return try JSONDecoder().decode(
                    KeychainDeleteOutcome.self,
                    from: handler.handle(body: JSONEncoder().encode(request)).body
                ).outcome
            }
            inspector.authorizeSessionMutations(sessionId: "active")
            XCTAssertEqual(try send(session: "active", token: nil), "mutation_not_authorized")
            inspector.authorizeHostMutations(true)
            XCTAssertEqual(try send(session: nil, token: nil), "mutation_not_authorized")
            XCTAssertEqual(try send(session: "stale", token: nil), "mutation_not_authorized")
            inspector.authorizeMutationToken("launch-token")
            XCTAssertEqual(try send(session: nil, token: "wrong-token"), "mutation_not_authorized")
            XCTAssertTrue(fake.queries.isEmpty)
            XCTAssertEqual(try send(session: "active", token: nil), "deleted")
            XCTAssertEqual(try send(session: nil, token: "launch-token"), "deleted")
            XCTAssertEqual(fake.queries.count, 2)
        }

        func testRejectsMissingSelectorAndConfirmation() throws {
            let empty = KeychainItemSelector(
                itemClass: "genericPassword",
                service: "",
                account: "fixture",
                accessGroup: "TEAMID.test.app"
            )
            let (invalid, invalidFake) = try response(selector: empty)
            XCTAssertEqual(invalid.outcome, "invalid_selector")
            XCTAssertTrue(invalidFake.queries.isEmpty)
            let (unconfirmed, unconfirmedFake) = try response(confirm: false)
            XCTAssertEqual(unconfirmed.outcome, "confirmation_required")
            XCTAssertTrue(unconfirmedFake.queries.isEmpty)
        }

        func testRejectsPolicyAndAuthorizationDenials() throws {
            let (otherApp, otherAppFake) = try response(appId: "other.app")
            XCTAssertEqual(otherApp.outcome, "app_id_mismatch")
            XCTAssertTrue(otherAppFake.queries.isEmpty)
            let (denied, deniedFake) = try response(allowed: false)
            XCTAssertEqual(denied.outcome, "scope_not_authorized")
            XCTAssertTrue(deniedFake.queries.isEmpty)
            let (unauthorized, unauthorizedFake) = try response(authorized: false)
            XCTAssertEqual(unauthorized.outcome, "mutation_not_authorized")
            XCTAssertTrue(unauthorizedFake.queries.isEmpty)
            let foreignGroup = KeychainItemSelector(
                itemClass: "genericPassword", service: "test.service", account: "fixture",
                accessGroup: "TEAMID.other.app"
            )
            let (foreign, foreignFake) = try response(selector: foreignGroup)
            XCTAssertEqual(foreign.outcome, "scope_not_authorized")
            XCTAssertTrue(foreignFake.queries.isEmpty)
        }

        func testRejectsCrossCombinationOfAllowedEntries() throws {
            let mixed = KeychainItemSelector(
                itemClass: "genericPassword", service: "test.service", account: "other",
                accessGroup: "TEAMID.test.app"
            )
            let (denied, fake) = try response(selector: mixed)
            XCTAssertEqual(denied.outcome, "scope_not_authorized")
            XCTAssertTrue(fake.queries.isEmpty)

            let (allowed, allowedFake) = try response()
            XCTAssertEqual(allowed.outcome, "deleted")
            XCTAssertEqual(allowedFake.queries.count, 1)
        }

        func testRejectsCanonicallyEquivalentButByteDifferentSelector() throws {
            // Keychain compares bytes; Swift String equality does not. Precomposed
            // allowlist entry vs decomposed request must not reach SecItemDelete.
            let fake = FakeKeychainDeleter()
            let policy = StorageInspectionConfiguration(
                allowMutations: true,
                allowKeychainDeletion: true,
                allowedKeychainDeletionEntries: [
                    KeychainDeletionEntry(service: "caf\u{E9}", account: "fixture", accessGroup: "TEAMID.test.app"),
                ]
            )
            let handler = SdkKeychainDeletionRouteHandler(
                keychain: fake,
                bundleId: { "test.app" },
                currentSessionId: { "active-session" },
                configuration: { policy },
                canMutate: { _, _, _ in true }
            )
            func send(service: String) throws -> KeychainDeleteOutcome {
                let body = try JSONEncoder().encode(TestRequest(
                    appId: "test.app", sessionId: "active-session", confirm: true,
                    selector: KeychainItemSelector(
                        itemClass: "genericPassword", service: service, account: "fixture",
                        accessGroup: "TEAMID.test.app"
                    )
                ))
                return try JSONDecoder().decode(KeychainDeleteOutcome.self, from: handler.handle(body: body).body)
            }
            let decomposed = try send(service: "cafe\u{301}")
            XCTAssertEqual(decomposed.outcome, "scope_not_authorized")
            XCTAssertTrue(fake.queries.isEmpty)
            let exact = try send(service: "caf\u{E9}")
            XCTAssertEqual(exact.outcome, "deleted")
            XCTAssertEqual(Array((fake.queries[0][kSecAttrService] as? String ?? "").utf8), Array("caf\u{E9}".utf8))
        }

        func testClassifiesSecurityFailuresWithoutClaimingDeletion() throws {
            for (status, expected) in [
                (errSecItemNotFound, "not_found"),
                (errSecNotAvailable, "protected_data_unavailable"),
                (errSecInteractionNotAllowed, "protected_data_unavailable"),
                (errSecUserCanceled, "user_auth_required"),
                (errSecParam, "keychain_error"),
                (errSecAuthFailed, "user_auth_required"),
                (errSecMissingEntitlement, "entitlement_denied"),
            ] {
                let (result, _) = try response(status: status)
                XCTAssertEqual(result.outcome, expected)
                XCTAssertNil(result.deletedScope)
            }
            let unsupported = KeychainItemSelector(
                itemClass: "certificate", service: "test.service", account: "fixture", accessGroup: "TEAMID.test.app"
            )
            let (result, fake) = try response(selector: unsupported)
            XCTAssertEqual(result.outcome, "unsupported_item_type")
            XCTAssertTrue(fake.queries.isEmpty)
        }
    }

    private struct TestRequest: Encodable {
        let appId: String
        let sessionId: String
        let confirm: Bool
        var mutationToken: String? = "launch-token"
        let selector: KeychainItemSelector
    }
#endif
