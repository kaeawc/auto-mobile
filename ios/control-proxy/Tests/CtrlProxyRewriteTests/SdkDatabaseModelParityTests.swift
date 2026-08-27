import Foundation
import XCTest

/// Differential parity for the SDK database result models (`SdkExecuteSqlResult`,
/// `SdkTableDataResult`, `SdkTableStructureResult`, `SdkStorageCapabilities`,
/// `SdkColumnInfo`, `SdkStorageDiagnostic`, `SdkDatabaseInfo`), `SdkHierarchyServerInfo`,
/// and the six DB response envelopes (Phase 3). Each golden is decoded then re-encoded
/// with sorted keys through BOTH modules; byte-identical output proves the ported field
/// set + custom decoders (notably `SdkExecuteSqlResult`'s tolerant `truncated`) match the
/// reference exactly. The envelopes carry a fixed `timestamp` in the golden so the
/// decode→encode round-trip is deterministic (their live-`Date()` init is not exercised).
final class SdkDatabaseModelParityTests: XCTestCase {
    private func assertReencodeEqual(
        _ reference: (Data) throws -> Data,
        _ rewrite: (Data) throws -> Data,
        _ golden: String,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let data = Data(golden.utf8)
        do {
            let ref = try reference(data)
            let rw = try rewrite(data)
            if ref != rw {
                XCTFail(
                    "\(label) re-encode diverged:\nreference: \(String(decoding: ref, as: UTF8.self))\nrewrite:   \(String(decoding: rw, as: UTF8.self))",
                    file: file,
                    line: line
                )
            }
        } catch {
            XCTFail("\(label) threw: \(error)", file: file, line: line)
        }
    }

    // MARK: - SDK result models

    func testStorageDiagnosticParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.diagnostic, RewriteSdkDatabase.diagnostic,
            #"{"code":"READ_ONLY","message":"database opened read-only"}"#, "SdkStorageDiagnostic"
        )
    }

    func testDatabaseInfoParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.databaseInfo, RewriteSdkDatabase.databaseInfo,
            #"{"name":"app.db","path":"/tmp/app.db","sizeBytes":40960}"#, "SdkDatabaseInfo(size)"
        )
        assertReencodeEqual(
            ReferenceSdkDatabase.databaseInfo, RewriteSdkDatabase.databaseInfo,
            #"{"name":"app.db","path":"/tmp/app.db"}"#, "SdkDatabaseInfo(no size)"
        )
    }

    func testColumnInfoParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.columnInfo, RewriteSdkDatabase.columnInfo,
            #"{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}"#,
            "SdkColumnInfo(null default)"
        )
        assertReencodeEqual(
            ReferenceSdkDatabase.columnInfo, RewriteSdkDatabase.columnInfo,
            #"{"name":"status","type":"TEXT","nullable":true,"primaryKey":false,"defaultValue":"active"}"#,
            "SdkColumnInfo(default)"
        )
    }

    func testStorageCapabilitiesParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.storageCapabilities, RewriteSdkDatabase.storageCapabilities,
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
        assertReencodeEqual(
            ReferenceSdkDatabase.executeSqlResult, RewriteSdkDatabase.executeSqlResult,
            """
            {"queryType":"SELECT","columns":["id","name","email"],
             "rows":[["1","alice",null],["2","bob","bob@example.com"]],
             "rowsAffected":0,"diagnostic":{"code":"OK","message":"2 rows"},"truncated":true}
            """,
            "SdkExecuteSqlResult(select)"
        )
        // Write result omitting `truncated` (tolerant decode → false) and columns/rows.
        assertReencodeEqual(
            ReferenceSdkDatabase.executeSqlResult, RewriteSdkDatabase.executeSqlResult,
            #"{"queryType":"UPDATE","rowsAffected":3}"#, "SdkExecuteSqlResult(write, no truncated)"
        )
        // Error result.
        assertReencodeEqual(
            ReferenceSdkDatabase.executeSqlResult, RewriteSdkDatabase.executeSqlResult,
            #"{"queryType":"UNKNOWN","rowsAffected":0,"error":"no such table: ghost"}"#,
            "SdkExecuteSqlResult(error)"
        )
    }

    func testTableDataResultParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.tableDataResult, RewriteSdkDatabase.tableDataResult,
            """
            {"columns":["id","name"],"rows":[["1","alice"],["2",null]],"total":2,
             "diagnostic":{"code":"OK","message":"ok"}}
            """,
            "SdkTableDataResult"
        )
    }

    func testTableStructureResultParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.tableStructureResult, RewriteSdkDatabase.tableStructureResult,
            """
            {"columns":[{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}],
             "diagnostic":null}
            """,
            "SdkTableStructureResult"
        )
    }

    func testServerInfoParity() throws {
        let golden = Data(#"{"status":"ok","bundleId":"com.example.app","capabilities":["hierarchy","network","db"]}"#.utf8)
        let ref = try ReferenceSdkDatabase.serverInfo(golden)
        let rw = try RewriteSdkDatabase.serverInfo(golden)
        XCTAssertEqual(ref.0, rw.0, "status")
        XCTAssertEqual(ref.1, rw.1, "bundleId")
        XCTAssertEqual(ref.2, rw.2, "capabilities (sorted)")
    }

    // MARK: - DB response envelopes (fixed timestamp for a deterministic round-trip)

    func testExecuteSqlResponseParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.executeSqlResponse, RewriteSdkDatabase.executeSqlResponse,
            """
            {"type":"execute_sql_result","timestamp":1730000000000,"requestId":"r1","success":true,
             "queryType":"SELECT","columns":["id"],"rows":[["1"]],"rowsAffected":0,
             "diagnostic":{"code":"OK","message":"1 row"},"truncated":false,"totalTimeMs":12}
            """,
            "ExecuteSqlResponse"
        )
    }

    func testListDatabasesResponseParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.listDatabasesResponse, RewriteSdkDatabase.listDatabasesResponse,
            """
            {"type":"list_databases_result","timestamp":1730000000000,"requestId":"r2","success":true,
             "databases":[{"name":"app.db","path":"/tmp/app.db","sizeBytes":100}],"totalTimeMs":5}
            """,
            "ListDatabasesResponse"
        )
    }

    func testStorageCapabilitiesResponseParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.storageCapabilitiesResponse, RewriteSdkDatabase.storageCapabilitiesResponse,
            """
            {"type":"storage_capabilities_result","timestamp":1730000000000,"requestId":"r3","success":true,
             "capabilities":{"readOnly":true,"mutationAuthorized":false,"registeredAppGroupSuites":[],
             "coreDataStores":[],"unavailableStores":[]},"totalTimeMs":7}
            """,
            "StorageCapabilitiesResponse"
        )
    }

    func testListTablesResponseParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.listTablesResponse, RewriteSdkDatabase.listTablesResponse,
            """
            {"type":"list_tables_result","timestamp":1730000000000,"requestId":"r4","success":true,
             "tables":["users","posts"],"totalTimeMs":3}
            """,
            "ListTablesResponse"
        )
    }

    func testTableDataResponseParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.tableDataResponse, RewriteSdkDatabase.tableDataResponse,
            """
            {"type":"table_data_result","timestamp":1730000000000,"requestId":"r5","success":true,
             "columns":["id","name"],"rows":[["1","alice"],["2",null]],"total":2,
             "diagnostic":{"code":"OK","message":"ok"},"totalTimeMs":9}
            """,
            "TableDataResponse"
        )
    }

    func testTableStructureResponseParity() {
        assertReencodeEqual(
            ReferenceSdkDatabase.tableStructureResponse, RewriteSdkDatabase.tableStructureResponse,
            """
            {"type":"table_structure_result","timestamp":1730000000000,"requestId":"r6","success":false,
             "error":"no such table","totalTimeMs":2}
            """,
            "TableStructureResponse"
        )
    }
}
