import Foundation
import XCTest

/// Wire-contract tests for the SDK database result models (`SdkExecuteSqlResult`,
/// `SdkTableDataResult`, `SdkTableStructureResult`, `SdkStorageCapabilities`,
/// `SdkColumnInfo`, `SdkStorageDiagnostic`, `SdkDatabaseInfo`), `SdkHierarchyServerInfo`,
/// and the six DB response envelopes (Phase 3).
///
/// Phase-7E re-anchor: these were differential-parity tests (decode→sorted-encode through
/// BOTH the reference and rewrite, diffed byte-for-byte). With the reference retired they are
/// re-anchored reference-free via `JSONGolden.assertReencodePreservesWire` — the round-trip
/// must be idempotent and preserve every wire field the input carried (containment tolerates
/// a model materializing a defaulted field, e.g. `SdkExecuteSqlResult`'s tolerant `truncated`).
/// Envelopes carry a fixed `timestamp` in the input and strip the top-level one on compare.
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
            RewriteSdkDatabase.diagnostic,
            #"{"code":"READ_ONLY","message":"database opened read-only"}"#, "SdkStorageDiagnostic"
        )
    }

    func testDatabaseInfoParity() {
        assertReencode(
            RewriteSdkDatabase.databaseInfo,
            #"{"name":"app.db","path":"/tmp/app.db","sizeBytes":40960}"#, "SdkDatabaseInfo(size)"
        )
        assertReencode(
            RewriteSdkDatabase.databaseInfo,
            #"{"name":"app.db","path":"/tmp/app.db"}"#, "SdkDatabaseInfo(no size)"
        )
    }

    func testColumnInfoParity() {
        assertReencode(
            RewriteSdkDatabase.columnInfo,
            #"{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}"#,
            "SdkColumnInfo(null default)"
        )
        assertReencode(
            RewriteSdkDatabase.columnInfo,
            #"{"name":"status","type":"TEXT","nullable":true,"primaryKey":false,"defaultValue":"active"}"#,
            "SdkColumnInfo(default)"
        )
    }

    func testStorageCapabilitiesParity() {
        assertReencode(
            RewriteSdkDatabase.storageCapabilities,
            """
            {"readOnly":false,"mutationAuthorized":true,
             "registeredAppGroupSuites":["group.a","group.b"],
             "coreDataStores":[{"identifier":"Main","modelVersion":"3","entities":["User","Post"]}],
             "unavailableStores":["encrypted.sqlite"]}
            """,
            "SdkStorageCapabilities"
        )
    }

    func testExecuteSqlResultParity() {
        // SELECT result: columns/rows/diagnostic/truncated all present, rows carry nulls.
        assertReencode(
            RewriteSdkDatabase.executeSqlResult,
            """
            {"queryType":"SELECT","columns":["id","name","email"],
             "rows":[["1","alice",null],["2","bob","bob@example.com"]],
             "rowsAffected":0,"diagnostic":{"code":"OK","message":"2 rows"},"truncated":true}
            """,
            "SdkExecuteSqlResult(select)"
        )
        // Write result omitting `truncated` (tolerant decode → false) and columns/rows.
        assertReencode(
            RewriteSdkDatabase.executeSqlResult,
            #"{"queryType":"UPDATE","rowsAffected":3}"#, "SdkExecuteSqlResult(write, no truncated)"
        )
        // Error result.
        assertReencode(
            RewriteSdkDatabase.executeSqlResult,
            #"{"queryType":"UNKNOWN","rowsAffected":0,"error":"no such table: ghost"}"#,
            "SdkExecuteSqlResult(error)"
        )
    }

    func testTableDataResultParity() {
        assertReencode(
            RewriteSdkDatabase.tableDataResult,
            """
            {"columns":["id","name"],"rows":[["1","alice"],["2",null]],"total":2,
             "diagnostic":{"code":"OK","message":"ok"}}
            """,
            "SdkTableDataResult"
        )
    }

    func testTableStructureResultParity() {
        assertReencode(
            RewriteSdkDatabase.tableStructureResult,
            """
            {"columns":[{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}],
             "diagnostic":null}
            """,
            "SdkTableStructureResult"
        )
    }

    func testServerInfoParity() throws {
        let golden = Data(#"{"status":"ok","bundleId":"com.example.app","capabilities":["hierarchy","network","db"]}"#.utf8)
        let info = try RewriteSdkDatabase.serverInfo(golden)
        XCTAssertEqual(info.0, "ok", "status")
        XCTAssertEqual(info.1, "com.example.app", "bundleId")
        XCTAssertEqual(info.2, ["db", "hierarchy", "network"], "capabilities (sorted)")
    }

    // MARK: - DB response envelopes (fixed timestamp for a deterministic round-trip)

    func testExecuteSqlResponseParity() {
        assertReencode(
            RewriteSdkDatabase.executeSqlResponse,
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
            RewriteSdkDatabase.listDatabasesResponse,
            """
            {"type":"list_databases_result","timestamp":1730000000000,"requestId":"r2","success":true,
             "databases":[{"name":"app.db","path":"/tmp/app.db","sizeBytes":100}],"totalTimeMs":5}
            """,
            stripTimestamp: true, "ListDatabasesResponse"
        )
    }

    func testStorageCapabilitiesResponseParity() {
        assertReencode(
            RewriteSdkDatabase.storageCapabilitiesResponse,
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
            RewriteSdkDatabase.listTablesResponse,
            """
            {"type":"list_tables_result","timestamp":1730000000000,"requestId":"r4","success":true,
             "tables":["users","posts"],"totalTimeMs":3}
            """,
            stripTimestamp: true, "ListTablesResponse"
        )
    }

    func testTableDataResponseParity() {
        assertReencode(
            RewriteSdkDatabase.tableDataResponse,
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
            RewriteSdkDatabase.tableStructureResponse,
            """
            {"type":"table_structure_result","timestamp":1730000000000,"requestId":"r6","success":false,
             "error":"no such table","totalTimeMs":2}
            """,
            stripTimestamp: true, "TableStructureResponse"
        )
    }
}
