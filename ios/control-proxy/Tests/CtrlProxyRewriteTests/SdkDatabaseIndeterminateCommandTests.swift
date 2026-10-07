@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// #10166 end to end through the command handler: an `execute_sql` the SDK never answered must come back
/// as an indeterminate outcome, not as the "embed the AutoMobile SDK" failure that invites a retry.
private actor ServerInfoHierarchyClient: SdkHierarchyFetching {
    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? {
        SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.sdk")
    }

    func isAvailable() async -> Bool { true }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { true }
    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { true }
    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool { true }
    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome { .rendered }
}

@MainActor
final class SdkDatabaseIndeterminateCommandTests: XCTestCase {
    private func execute(_ outcome: StubOutcome) async throws -> ExecuteSqlResponse {
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = "com.example.sdk"
        let baseURL = try XCTUnwrap(URL(string: "http://localhost:8766"))
        let transport = StubHTTPTransport([outcome])
        let handler = CommandHandler(
            elementLocator: locator,
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            sdkHierarchyClient: ServerInfoHierarchyClient(),
            sdkDatabaseClient: SdkDatabaseClient(baseURL: baseURL, transport: transport)
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(
                #"{"type":"execute_sql","requestId":"r1","appId":"com.example.sdk","databasePath":"/db","query":"INSERT INTO audit(msg) VALUES ('x')"}"#
                    .utf8
            )
        )
        let response = await handler.handle(request)
        return try XCTUnwrap(response as? ExecuteSqlResponse)
    }

    func testTimedOutWriteIsReportedAsIndeterminate() async throws {
        let response = try await execute(.timedOut)

        XCTAssertFalse(response.success)
        let error = try XCTUnwrap(response.error)
        XCTAssertFalse(error.contains("embed the AutoMobile SDK"), error)
        XCTAssertTrue(error.contains("indeterminate"), error)
        XCTAssertTrue(error.contains("Do not retry automatically"), error)
    }

    func testBusyDatabaseIsReportedAsBusyWithoutTheEmbedSdkText() async throws {
        let busy = Data(#"{"error":"busy_lock"}"#.utf8)
        let response = try await execute(.respond(status: 503, body: busy))

        XCTAssertFalse(response.success)
        let error = try XCTUnwrap(response.error)
        XCTAssertFalse(error.contains("embed the AutoMobile SDK"), error)
        XCTAssertTrue(error.hasSuffix(": busy_lock"), error)
    }
}
