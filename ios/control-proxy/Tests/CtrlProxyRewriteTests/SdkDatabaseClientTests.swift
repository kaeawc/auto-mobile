@testable import CtrlProxyRewrite
import Foundation
import XCTest

// Test fixtures fail-fast on malformed setup data, so force-unwrap is idiomatic here
// (blanket-allowed for force_unwrapping in test targets — see .swiftlint.yml).
// swiftlint:disable force_unwrapping

/// Behavior tests for the async `SdkDatabaseClient` (Phase 3). Rewrite-only tests over
/// the `HTTPRequesting` seam that pin the reference's error mapping: a non-2xx status →
/// `SdkDatabaseError.unavailable` (carrying the SDK's `{"error":…}` payload when present,
/// else `HTTP <code>`), a non-HTTP completion → `.badResponse`, a transport failure →
/// `.unavailable` (carrying the underlying error). Success decodes the typed payload.
final class SdkDatabaseClientTests: XCTestCase {
    private let baseURL = URL(string: "http://localhost:8766")!

    private func makeClient(_ stub: StubHTTPTransport) -> SdkDatabaseClient {
        SdkDatabaseClient(baseURL: baseURL, transport: stub)
    }

    /// Assert an async database call throws a `SdkDatabaseError` matching `predicate`.
    private func assertThrows(
        _ operation: () async throws -> Void,
        _ predicate: (SdkDatabaseError) -> Bool,
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("expected SdkDatabaseError: \(message)", file: file, line: line)
        } catch let error as SdkDatabaseError {
            XCTAssertTrue(predicate(error), "\(message); got \(error)", file: file, line: line)
        } catch {
            XCTFail("expected SdkDatabaseError, got \(error)", file: file, line: line)
        }
    }

    // MARK: - executeSQL success + request shape

    func testExecuteSqlDecodesAndPostsRequest() async throws {
        let stub = StubHTTPTransport(
            status: 200,
            body: Data(#"{"queryType":"SELECT","columns":["id"],"rows":[["1"]],"rowsAffected":0}"#.utf8)
        )
        let result = try await makeClient(stub).executeSQL(databasePath: "/db", query: "SELECT 1", sessionId: "s1")
        XCTAssertEqual(result.queryType, "SELECT")
        XCTAssertEqual(result.columns, ["id"])
        XCTAssertEqual(result.rows, [["1"]])
        XCTAssertFalse(result.truncated)

        let request = try XCTUnwrap(stub.recordedRequests.first)
        XCTAssertEqual(request.url?.path, "/db/execute")
        XCTAssertEqual(request.httpMethod, "POST")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["databasePath"] as? String, "/db")
        XCTAssertEqual(json["query"] as? String, "SELECT 1")
        XCTAssertEqual(json["sessionId"] as? String, "s1")
    }

    // MARK: - executeSQL error mapping

    func testExecuteSqlUnavailableWithServerErrorPayload() async {
        let stub = StubHTTPTransport([.respond(status: 400, body: Data(#"{"error":"no such table: ghost"}"#.utf8))])
        await assertThrows(
            { _ = try await self.makeClient(stub).executeSQL(databasePath: "/db", query: "x", sessionId: nil) },
            { if case let .unavailable(m) = $0 { return m.contains("no such table: ghost") } else { return false } },
            "non-2xx with payload must carry the SDK error message"
        )
    }

    func testExecuteSqlUnavailableWithHttpCodeWhenNoPayload() async {
        let stub = StubHTTPTransport([.respond(status: 503, body: Data("{}".utf8))])
        await assertThrows(
            { _ = try await self.makeClient(stub).executeSQL(databasePath: "/db", query: "x", sessionId: nil) },
            { if case let .unavailable(m) = $0 { return m.contains("HTTP 503") } else { return false } },
            "non-2xx without payload must fall back to HTTP <code>"
        )
    }

    func testExecuteSqlBadResponseOnNonHTTP() async {
        let stub = StubHTTPTransport([.nonHTTPResponse])
        await assertThrows(
            { _ = try await self.makeClient(stub).executeSQL(databasePath: "/db", query: "x", sessionId: nil) },
            { if case .badResponse = $0 { return true } else { return false } },
            "a non-HTTP completion must map to .badResponse"
        )
    }

    func testExecuteSqlUnavailableOnTransportError() async {
        let stub = StubHTTPTransport([.transportError])
        await assertThrows(
            { _ = try await self.makeClient(stub).executeSQL(databasePath: "/db", query: "x", sessionId: nil) },
            { if case .unavailable = $0 { return true } else { return false } },
            "a transport error must map to .unavailable"
        )
    }

    // MARK: - other endpoints decode + route

    func testListDatabasesDecodes() async throws {
        let stub = StubHTTPTransport(
            status: 200,
            body: Data(#"{"databases":[{"name":"a.db","path":"/a.db","sizeBytes":10}]}"#.utf8)
        )
        let databases = try await makeClient(stub).listDatabases()
        XCTAssertEqual(databases, [SdkDatabaseInfo(name: "a.db", path: "/a.db", sizeBytes: 10)])
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/db/list")
    }

    func testStorageCapabilitiesDecodes() async throws {
        let stub = StubHTTPTransport(
            status: 200,
            body: Data("""
            {"readOnly":true,"mutationAuthorized":false,"registeredAppGroupSuites":["g"],
             "coreDataStores":[],"unavailableStores":[]}
            """.utf8)
        )
        let capabilities = try await makeClient(stub).storageCapabilities()
        XCTAssertTrue(capabilities.readOnly)
        XCTAssertFalse(capabilities.mutationAuthorized)
        XCTAssertEqual(capabilities.registeredAppGroupSuites, ["g"])
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/db/capabilities")
    }

    func testListTablesDecodesAndPostsPath() async throws {
        let stub = StubHTTPTransport(status: 200, body: Data(#"{"tables":["users","posts"]}"#.utf8))
        let tables = try await makeClient(stub).listTables(databasePath: "/db")
        XCTAssertEqual(tables, ["users", "posts"])
        let request = try XCTUnwrap(stub.recordedRequests.first)
        XCTAssertEqual(request.url?.path, "/db/tables")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["databasePath"] as? String, "/db")
    }

    func testGetTableDataDecodesAndSendsLimitOffset() async throws {
        let stub = StubHTTPTransport(
            status: 200,
            body: Data(#"{"columns":["id"],"rows":[["1"],["2"]],"total":2}"#.utf8)
        )
        let data = try await makeClient(stub).getTableData(databasePath: "/db", table: "t", limit: 50, offset: 100)
        XCTAssertEqual(data.total, 2)
        XCTAssertEqual(data.rows.count, 2)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(stub.recordedRequests.first?.httpBody)) as? [String: Any])
        XCTAssertEqual(json["limit"] as? Int, 50)
        XCTAssertEqual(json["offset"] as? Int, 100)
        XCTAssertEqual(json["table"] as? String, "t")
    }

    func testGetTableStructureDecodes() async throws {
        let stub = StubHTTPTransport(
            status: 200,
            body: Data("""
            {"columns":[{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null}],
             "diagnostic":null}
            """.utf8)
        )
        let structure = try await makeClient(stub).getTableStructure(databasePath: "/db", table: "t")
        XCTAssertEqual(structure.columns.first?.name, "id")
        XCTAssertTrue(structure.columns.first?.primaryKey ?? false)
        XCTAssertEqual(stub.recordedRequests.first?.url?.path, "/db/table-structure")
    }
}
