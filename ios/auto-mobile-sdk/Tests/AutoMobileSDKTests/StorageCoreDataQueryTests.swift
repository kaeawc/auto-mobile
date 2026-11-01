#if DEBUG && !os(watchOS)
    @testable import AutoMobileSDK
    import AutoMobileSdkWire
    import Foundation
    import XCTest

    final class StorageCoreDataQueryTests: XCTestCase {
        private struct Fetcher: CoreDataReadOnlyFetching {
            func fetch(entity: String, limit: Int) throws -> CoreDataQueryResult {
                XCTAssertEqual(entity, "Item")
                XCTAssertEqual(limit, 2)
                return CoreDataQueryResult(
                    columns: ["name", "token"],
                    rows: [["A", "secret"], ["B", nil]],
                    truncated: true
                )
            }
        }

        override func tearDown() {
            DatabaseInspector.shared.reset()
            super.tearDown()
        }

        private func configure(fetcher: (any CoreDataReadOnlyFetching)? = Fetcher()) {
            DatabaseInspector.shared.reset()
            DatabaseInspector.shared.configure(StorageInspectionConfiguration(
                coreDataStores: [.init(identifier: "Main", entities: ["Item"], fetcher: fetcher)],
                maxRows: 2
            ))
            DatabaseInspector.shared.setEnabled(true)
        }

        private func query(
            store: String = "Main",
            entity: String = "Item",
            limit: Int? = 99
        )
            throws -> SdkRouteResponse
        {
            try SdkDatabaseRouteHandler().handleCoreDataQuery(body: JSONEncoder().encode(
                CoreDataQueryRequest(store: store, entity: entity, limit: limit)
            ))
        }

        func testClampsLimitRedactsAndPreservesTruncationWithoutMutationAuthorization() throws {
            configure()
            let response = try query()
            XCTAssertEqual(response.statusCode, 200)
            let result = try JSONDecoder().decode(CoreDataQueryResult.self, from: response.body)
            XCTAssertEqual(result.rows, [["A", "[REDACTED]"], ["B", nil]])
            XCTAssertTrue(result.truncated)
            XCTAssertFalse(DatabaseInspector.shared.inspectionConfiguration.allowMutations)
            XCTAssertEqual(try query(limit: nil).statusCode, 200)
        }

        func testUnknownStoreAndEntityAreStructuredErrors() throws {
            configure()
            for (store, entity, code) in [
                ("missing", "Item", "unknown_core_data_store"),
                ("Main", "Other", "unknown_core_data_entity"),
            ] {
                let response = try query(store: store, entity: entity)
                XCTAssertEqual(response.statusCode, 404)
                let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
                XCTAssertEqual(payload.diagnostic?.code, code)
            }
        }

        func testUnsupportedWithoutFetcherAndSupportedWithFetcher() throws {
            configure(fetcher: nil)
            XCTAssertEqual(
                StorageStoreState.states(for: DatabaseInspector.shared.inspectionConfiguration).first?.query,
                "unsupported"
            )
            XCTAssertEqual(try query().statusCode, 501)
            configure()
            XCTAssertEqual(
                StorageStoreState.states(for: DatabaseInspector.shared.inspectionConfiguration).first?.query,
                "supported"
            )
            let encoded = try JSONEncoder().encode(DatabaseInspector.shared.inspectionConfiguration.coreDataStores[0])
            let decoded = try JSONDecoder().decode(CoreDataStoreRegistration.self, from: encoded)
            XCTAssertNil(decoded.fetcher)
        }

        func testDisabledAndMalformedRequestsFailClosed() throws {
            configure()
            XCTAssertEqual(try query(limit: 0).statusCode, 400)
            XCTAssertEqual(SdkDatabaseRouteHandler().handleCoreDataQuery(body: Data("{}".utf8)).statusCode, 400)
            DatabaseInspector.shared.setEnabled(false)
            XCTAssertEqual(try query().statusCode, 503)
        }
    }
#endif
