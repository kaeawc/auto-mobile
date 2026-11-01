#if DEBUG && !os(watchOS)
    @testable import AutoMobileSDK
    import AutoMobileSdkWire
    import Foundation
    import XCTest

    /// Keychain capability and shared-store states in the storage capability payload (#5161).
    final class StorageCapabilityStatesTests: XCTestCase {
        private let entry = KeychainDeletionEntry(
            service: "fixture.service",
            account: "fixture.account",
            accessGroup: "TEAMID.fixture"
        )

        func testKeychainDeletionIsDisabledByDefault() {
            let keychain = KeychainCapability.capability(for: StorageInspectionConfiguration())
            XCTAssertEqual(keychain.capability, "storage.keychain")
            XCTAssertEqual(keychain.inspection, "unavailable")
            XCTAssertEqual(keychain.deletion, "disabled")
            XCTAssertEqual(keychain.reason, "DISABLED")
            XCTAssertEqual(keychain.deletionScopes, [])
        }

        func testAllowlistedEntriesAreNotReportedWhileDeletionIsOff() {
            let keychain = KeychainCapability.capability(
                for: StorageInspectionConfiguration(allowedKeychainDeletionEntries: [entry])
            )
            XCTAssertEqual(keychain.deletion, "disabled")
            XCTAssertEqual(keychain.deletionScopes, [])
        }

        func testDeletionWithoutAllowlistedScopesStaysDisabled() {
            let keychain = KeychainCapability.capability(
                for: StorageInspectionConfiguration(allowKeychainDeletion: true)
            )
            XCTAssertEqual(keychain.deletion, "disabled")
            XCTAssertEqual(keychain.reason, "NO_ALLOWLISTED_SCOPES")
        }

        func testEnabledDeletionListsExactlyTheAllowlistedScopesInOrder() {
            let other = KeychainDeletionEntry(service: "a.service", account: "z", accessGroup: "TEAMID.fixture")
            let keychain = KeychainCapability.capability(
                for: StorageInspectionConfiguration(
                    allowKeychainDeletion: true,
                    allowedKeychainDeletionEntries: [entry, other]
                )
            )
            XCTAssertEqual(keychain.deletion, "enabled")
            XCTAssertNil(keychain.reason)
            XCTAssertEqual(keychain.deletionScopes.map(\.service), ["a.service", "fixture.service"])
            XCTAssertEqual(Set(keychain.deletionScopes.map(\.itemClass)), ["genericPassword"])
        }

        func testKeychainCapabilityEncodesNoValueFields() throws {
            let keychain = KeychainCapability.capability(
                for: StorageInspectionConfiguration(
                    allowKeychainDeletion: true,
                    allowedKeychainDeletionEntries: [entry]
                )
            )
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: JSONEncoder().encode(keychain)) as? [String: Any]
            )
            XCTAssertEqual(
                Set(object.keys),
                ["schemaVersion", "capability", "inspection", "deletion", "deletionScopes"]
            )
            let scope = try XCTUnwrap((object["deletionScopes"] as? [[String: Any]])?.first)
            XCTAssertEqual(Set(scope.keys), ["itemClass", "service", "account", "accessGroup"])
        }

        func testAppGroupSuitesReportTheDeclaredCoordination() {
            let inspector = DatabaseInspector.shared
            inspector.reset()
            defer { inspector.reset() }
            inspector.registerAppGroupSuite("group.b")
            inspector.registerAppGroupSuite("group.a", coordination: .hostCoordinated)

            let states = StorageStoreState.states(for: inspector.inspectionConfiguration)
            XCTAssertEqual(states.map(\.identifier), ["group.a", "group.b"])
            XCTAssertEqual(states.map(\.coordination), ["host_coordinated", "uncoordinated"])
            XCTAssertEqual(Set(states.map(\.sharing)), ["app_group"])
            XCTAssertEqual(Set(states.map(\.query)), ["supported"])

            // Registering again replaces the declaration instead of keeping a stale one.
            inspector.registerAppGroupSuite("group.a")
            XCTAssertEqual(
                StorageStoreState.states(for: inspector.inspectionConfiguration).first?.coordination,
                "uncoordinated"
            )
        }

        func testCoreDataStoresReportSharingCoordinationAndUnsupportedQueries() {
            let states = StorageStoreState.states(for: StorageInspectionConfiguration(coreDataStores: [
                CoreDataStoreRegistration(identifier: "Private"),
                CoreDataStoreRegistration(identifier: "Shared", appGroup: "group.fixture"),
                CoreDataStoreRegistration(
                    identifier: "Coordinated",
                    appGroup: "group.fixture",
                    coordination: .hostCoordinated
                ),
            ]))
            XCTAssertEqual(states.map(\.identifier), ["Coordinated", "Private", "Shared"])
            XCTAssertEqual(states.map(\.sharing), ["app_group", "app_private", "app_group"])
            XCTAssertEqual(states.map(\.coordination), ["host_coordinated", "single_process", "uncoordinated"])
            XCTAssertEqual(Set(states.map(\.query)), ["unsupported"])
            XCTAssertEqual(Set(states.compactMap(\.reason)), ["core_data_query_unavailable"])
        }
    }
#endif
