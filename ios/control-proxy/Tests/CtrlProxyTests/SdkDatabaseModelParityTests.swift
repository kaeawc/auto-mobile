import Foundation
import XCTest

final class SdkDatabaseModelParityTests: XCTestCase {
    private func assertReencode(
        _ reencode: (Data) throws -> Data,
        _ input: String,
        stripTimestamp: Bool = false,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        JSONGolden.assertReencodePreservesWire(
            reencode, input: input, stripTimestamp: stripTimestamp, label, file: file, line: line
        )
    }

    // MARK: - SDK result models

    func testStorageDiagnosticParity() {
        assertReencode(
            SdkDatabase.diagnostic,
            #"{"code":"READ_ONLY","message":"database opened read-only"}"#, "SdkStorageDiagnostic"
        )
    }

    func testDatabaseInfoParity() {
        assertReencode(
            SdkDatabase.databaseInfo,
            #"{"name":"app.db","path":"/tmp/app.db","sizeBytes":40960}"#, "SdkDatabaseInfo(size)"
        )
        assertReencode(
            SdkDatabase.databaseInfo,
            #"{"name":"app.db","path":"/tmp/app.db"}"#, "SdkDatabaseInfo(no size)"
        )
    }

    func testColumnInfoParity() {
        assertReencode(
            SdkDatabase.columnInfo,
            #"{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}"#,
            "SdkColumnInfo(null default)"
        )
        assertReencode(
            SdkDatabase.columnInfo,
            #"{"name":"status","type":"TEXT","nullable":true,"primaryKey":false,"defaultValue":"active"}"#,
            "SdkColumnInfo(default)"
        )
    }

    func testStorageCapabilitiesParity() {
        assertReencode(
            SdkDatabase.storageCapabilities,
            """
            {"readOnly":false,"mutationAuthorized":true,
             "registeredAppGroupSuites":["group.a","group.b"],
             "coreDataStores":[{"identifier":"Main","modelVersion":"3","entities":["User","Post"]}],
             "unavailableStores":["encrypted.sqlite"]}
            """,
            "SdkStorageCapabilities"
        )
    }

    /// The #5161 store states and Keychain capability pass through CtrlProxy unchanged.
    func testStorageCapabilitiesWithStoresAndKeychainParity() {
        assertReencode(
            SdkDatabase.storageCapabilities,
            """
            {"readOnly":true,"mutationAuthorized":false,"registeredAppGroupSuites":["group.a"],
             "coreDataStores":[],"unavailableStores":["keychain","file_caches"],
             "stores":[{"kind":"user_defaults_suite","identifier":"group.a","sharing":"app_group",
               "appGroup":"group.a","coordination":"host_coordinated","query":"supported"}],
             "keychain":{"schemaVersion":1,"capability":"storage.keychain","inspection":"unavailable",
               "deletion":"enabled","deletionScopes":[{"itemClass":"genericPassword","service":"s",
               "account":"a","accessGroup":"TEAMID.g"}]}}
            """,
            "SdkStorageCapabilities(stores, keychain)"
        )
    }

    func testExecuteSqlResultParity() {
        // SELECT result: columns/rows/diagnostic/truncated all present, rows carry nulls.
        assertReencode(
            SdkDatabase.executeSqlResult,
            """
            {"queryType":"SELECT","columns":["id","name","email"],
             "rows":[["1","alice",null],["2","bob","bob@example.com"]],
             "rowsAffected":0,"diagnostic":{"code":"OK","message":"2 rows"},"truncated":true}
            """,
            "SdkExecuteSqlResult(select)"
        )
        // Write result omitting `truncated` (tolerant decode → false) and columns/rows.
        assertReencode(
            SdkDatabase.executeSqlResult,
            #"{"queryType":"UPDATE","rowsAffected":3}"#, "SdkExecuteSqlResult(write, no truncated)"
        )
        // Error result.
        assertReencode(
            SdkDatabase.executeSqlResult,
            #"{"queryType":"UNKNOWN","rowsAffected":0,"error":"no such table: ghost"}"#,
            "SdkExecuteSqlResult(error)"
        )
    }

    func testTableDataResultParity() {
        assertReencode(
            SdkDatabase.tableDataResult,
            """
            {"columns":["id","name"],"rows":[["1","alice"],["2",null]],"total":2,
             "diagnostic":{"code":"OK","message":"ok"}}
            """,
            "SdkTableDataResult"
        )
    }

    func testTableStructureResultParity() {
        assertReencode(
            SdkDatabase.tableStructureResult,
            """
            {"columns":[{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}],
             "diagnostic":null}
            """,
            "SdkTableStructureResult"
        )
    }

    func testServerInfoParity() throws {
        let golden = Data(
            #"{"status":"ok","bundleId":"com.example.app","capabilities":["hierarchy","network","db"]}"#
                .utf8
        )
        let info = try SdkDatabase.serverInfo(golden)
        XCTAssertEqual(info.0, "ok", "status")
        XCTAssertEqual(info.1, "com.example.app", "bundleId")
        XCTAssertEqual(info.2, ["db", "hierarchy", "network"], "capabilities (sorted)")
    }

    // MARK: - DB response envelopes (fixed timestamp for a deterministic round-trip)

    func testExecuteSqlResponseParity() {
        assertReencode(
            SdkDatabase.executeSqlResponse,
            """
            {"type":"execute_sql_result","timestamp":1730000000000,"requestId":"r1","success":true,
             "queryType":"SELECT","columns":["id"],"rows":[["1"]],"rowsAffected":0,
             "diagnostic":{"code":"OK","message":"1 row"},"truncated":false,"totalTimeMs":12}
            """,
            stripTimestamp: true, "ExecuteSqlResponse"
        )
    }

    func testListDatabasesResponseParity() {
        assertReencode(
            SdkDatabase.listDatabasesResponse,
            """
            {"type":"list_databases_result","timestamp":1730000000000,"requestId":"r2","success":true,
             "databases":[{"name":"app.db","path":"/tmp/app.db","sizeBytes":100}],"totalTimeMs":5}
            """,
            stripTimestamp: true, "ListDatabasesResponse"
        )
    }

    func testStorageCapabilitiesResponseParity() {
        assertReencode(
            SdkDatabase.storageCapabilitiesResponse,
            """
            {"type":"storage_capabilities_result","timestamp":1730000000000,"requestId":"r3","success":true,
             "capabilities":{"readOnly":true,"mutationAuthorized":false,"registeredAppGroupSuites":[],
             "coreDataStores":[],"unavailableStores":[]},"totalTimeMs":7}
            """,
            stripTimestamp: true, "StorageCapabilitiesResponse"
        )
    }

    func testListTablesResponseParity() {
        assertReencode(
            SdkDatabase.listTablesResponse,
            """
            {"type":"list_tables_result","timestamp":1730000000000,"requestId":"r4","success":true,
             "tables":["users","posts"],"totalTimeMs":3}
            """,
            stripTimestamp: true, "ListTablesResponse"
        )
    }

    func testTableDataResponseParity() {
        assertReencode(
            SdkDatabase.tableDataResponse,
            """
            {"type":"table_data_result","timestamp":1730000000000,"requestId":"r5","success":true,
             "columns":["id","name"],"rows":[["1","alice"],["2",null]],"total":2,
             "diagnostic":{"code":"OK","message":"ok"},"totalTimeMs":9}
            """,
            stripTimestamp: true, "TableDataResponse"
        )
    }

    func testTableStructureResponseParity() {
        assertReencode(
            SdkDatabase.tableStructureResponse,
            """
            {"type":"table_structure_result","timestamp":1730000000000,"requestId":"r6","success":false,
             "error":"no such table","totalTimeMs":2}
            """,
            stripTimestamp: true, "TableStructureResponse"
        )
    }
}
