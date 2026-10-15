@testable import CtrlProxyRewrite
import Foundation
import XCTest

private struct FailureWireHierarchy: SdkHierarchyFetching {
    let bundleId: String
    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? { SdkHierarchyServerInfo(status: "ok", bundleId: bundleId) }
    func isAvailable() async -> Bool { true }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { true }
    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { true }
    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool { true }
    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome { .unavailable }
}

private struct FailureWireDatabase: SdkDatabaseFetching {
    let sqlError: String?
    func executeSQL(
        databasePath _: String,
        query _: String,
        sessionId _: String?,
        mutationToken _: String?,
        readOnly _: Bool?
    )
        async throws -> SdkExecuteSqlResult
    {
        SdkExecuteSqlResult(queryType: "SELECT", rowsAffected: 0, error: sqlError)
    }

    func listDatabases() async throws -> [SdkDatabaseInfo] { [] }
    func storageCapabilities() async throws -> SdkStorageCapabilities {
        SdkStorageCapabilities(
            readOnly: true,
            mutationAuthorized: false,
            registeredAppGroupSuites: [],
            coreDataStores: [],
            unavailableStores: []
        )
    }

    func listTables(databasePath _: String) async throws -> [String] { [] }
    func getTableData(
        databasePath _: String,
        table _: String,
        limit _: Int,
        offset _: Int
    )
        async throws -> SdkTableDataResult
    {
        SdkTableDataResult(columns: [], rows: [], total: 0)
    }

    func getTableStructure(databasePath _: String, table _: String) async throws -> SdkTableStructureResult {
        SdkTableStructureResult(columns: [])
    }
}

@MainActor
private final class FailureWireVoiceOverToggle: VoiceOverToggling {
    func setVoiceOver(enabled _: Bool) throws { throw VoiceOverToggleError.switchStateUnreadable }
}

private struct FailureWireHingeSetter: HingeAngleSetting {
    func setHingeAngle(_: Double) throws { throw HingeAngleError.dispatchFailed }
}

@MainActor
final class FailureResponseWireTests: XCTestCase {
    private let app = "com.example.app"
    private let requestId = "wire-test"
    private let unavailable =
        "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)"

    private func request(_ type: String, _ fields: [String: Any] = [:]) throws -> WebSocketRequest {
        var payload = fields
        payload["type"] = type
        payload["requestId"] = requestId
        if payload["appId"] == nil { payload["appId"] = app }
        return try JSONDecoder().decode(WebSocketRequest.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    private func handler(
        foreground: String? = nil,
        serverBundle: String? = nil,
        database: Bool = false,
        sqlError: String? = nil,
        voiceFailure: Bool = false,
        hingeFailure: Bool = false
    )
        -> CommandHandler
    {
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = foreground
        return CommandHandler(
            elementLocator: locator,
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            sdkHierarchyClient: serverBundle.map { FailureWireHierarchy(bundleId: $0) },
            sdkDatabaseClient: database ? FailureWireDatabase(sqlError: sqlError) : nil,
            voiceOverToggle: voiceFailure ? FailureWireVoiceOverToggle() : DefaultVoiceOverToggle(),
            hingeAngleSetter: hingeFailure ? FailureWireHingeSetter() : DefaultHingeAngleSetter()
        )
    }

    private func assertFailure(
        _ type: String,
        fields: [String: Any] = [:],
        using handler: CommandHandler,
        expected: [String: Any],
        file: StaticString = #filePath,
        line: UInt = #line
    )
        async throws
    {
        let response = try await handler.handle(request(type, fields))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var actual = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(response)) as? [String: Any])
        actual.removeValue(forKey: "timestamp")
        actual.removeValue(forKey: "totalTimeMs")
        XCTAssertTrue((actual as NSDictionary).isEqual(to: expected), "actual: \(actual)", file: file, line: line)
    }

    func testDatabaseClientAbsentFailures() async throws {
        for (type, responseType) in [
            ("execute_sql", "execute_sql_result"), ("list_databases", "list_databases_result"),
            ("storage_capabilities", "storage_capabilities_result"), ("list_tables", "list_tables_result"),
            ("get_table_data", "table_data_result"), ("get_table_structure", "table_structure_result"),
        ] {
            try await assertFailure(
                type,
                using: handler(),
                expected: ["type": responseType, "requestId": requestId, "success": false, "error": unavailable]
            )
        }
    }

    func testDatabaseMissingParameterFailures() async throws {
        let database = handler(foreground: app, serverBundle: app, database: true)
        try await assertFailure(
            "execute_sql",
            fields: ["databasePath": "/db"],
            using: database,
            expected: [
                "type": "execute_sql_result",
                "requestId": requestId,
                "success": false,
                "error": "Missing required parameter: query",
            ]
        )
        for type in ["execute_sql", "list_tables", "get_table_data", "get_table_structure"] {
            var fields: [String: Any] = [:]
            if type == "execute_sql" { fields["query"] = "SELECT 1" }
            if type == "get_table_data" || type == "get_table_structure" { fields["table"] = "users" }
            let responseTypes = [
                "execute_sql": "execute_sql_result",
                "list_tables": "list_tables_result",
                "get_table_data": "table_data_result",
                "get_table_structure": "table_structure_result",
            ]
            let responseType = try XCTUnwrap(responseTypes[type])
            try await assertFailure(
                type,
                fields: fields,
                using: database,
                expected: [
                    "type": responseType,
                    "requestId": requestId,
                    "success": false,
                    "error": "Missing required parameter: databasePath",
                ]
            )
        }
        for type in ["get_table_data", "get_table_structure"] {
            let responseType = type == "get_table_data" ? "table_data_result" : "table_structure_result"
            try await assertFailure(
                type,
                fields: ["databasePath": "/db"],
                using: database,
                expected: [
                    "type": responseType,
                    "requestId": requestId,
                    "success": false,
                    "error": "Missing required parameter: table",
                ]
            )
        }
    }

    func testDatabaseForegroundMismatchFailures() async throws {
        for (type, responseType) in [
            ("execute_sql", "execute_sql_result"), ("list_databases", "list_databases_result"),
            ("storage_capabilities", "storage_capabilities_result"), ("list_tables", "list_tables_result"),
            ("get_table_data", "table_data_result"), ("get_table_structure", "table_structure_result"),
        ] {
            try await assertFailure(
                type,
                fields: ["databasePath": "/db", "table": "users", "query": "SELECT 1"],
                using: handler(foreground: "com.other.app", serverBundle: app, database: true),
                expected: [
                    "type": responseType,
                    "requestId": requestId,
                    "success": false,
                    "error": "Command execution failed: Database inspection requires requested appId \(app) to be the foreground app",
                ]
            )
        }
    }

    func testExecuteSqlClientErrorFailure() async throws {
        try await assertFailure(
            "execute_sql",
            fields: ["databasePath": "/db", "query": "SELECT 1"],
            using: handler(foreground: app, serverBundle: app, database: true, sqlError: "bad query"),
            expected: ["type": "execute_sql_result", "requestId": requestId, "success": false, "error": "bad query"]
        )
    }

    func testStorageCatchFailures() async throws {
        try await assertFailure(
            "list_preference_files",
            fields: ["appId": ""],
            using: handler(),
            expected: [
                "type": "preference_files",
                "requestId": requestId,
                "success": false,
                "error": "Missing required parameter: appId",
            ]
        )
        try await assertFailure(
            "get_preferences",
            fields: ["appId": ""],
            using: handler(),
            expected: [
                "type": "preferences",
                "requestId": requestId,
                "success": false,
                "error": "Missing required parameter: appId",
            ]
        )
        try await assertFailure(
            "get_preference",
            fields: ["appId": ""],
            using: handler(),
            expected: [
                "type": "get_preference_result",
                "requestId": requestId,
                "success": false,
                "found": false,
                "error": "Missing required parameter: appId",
            ]
        )
    }

    func testAccessibilityFailureResponses() async throws {
        try await assertFailure(
            "set_voiceover_state",
            fields: ["enabled": true],
            using: handler(voiceFailure: true),
            expected: [
                "type": "voiceover_set_result",
                "requestId": requestId,
                "success": false,
                "error": "VoiceOver switch state could not be read in Settings",
            ]
        )
        try await assertFailure(
            "set_hinge_angle",
            fields: ["angle": 181],
            using: handler(),
            expected: [
                "type": "hinge_angle_result",
                "requestId": requestId,
                "success": false,
                "error": "Hinge angle must be a finite number from 0 to 180 degrees.",
            ]
        )
        try await assertFailure(
            "set_hinge_angle",
            fields: ["angle": 90],
            using: handler(hingeFailure: true),
            expected: [
                "type": "hinge_angle_result",
                "requestId": requestId,
                "success": false,
                "error": "iOS simulator rejected the hinge angle event.",
            ]
        )
    }
}
