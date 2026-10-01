@testable import CtrlProxyRewrite
import Foundation
import XCTest

private struct PreferenceHierarchyServer: SdkHierarchyFetching {
    let bundleId: String?

    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? {
        guard let bundleId else { return nil }
        return SdkHierarchyServerInfo(status: "ok", bundleId: bundleId)
    }

    func isAvailable() async -> Bool { bundleId != nil }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { false }
    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { false }
    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool { false }
    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome { .unavailable }
}

private actor RecordingPreferenceClient: SdkPreferenceFetching {
    private var operations: [String] = []
    private var mutationTokens: [String?] = []
    func recorded() -> [String] { operations }
    func recordedTokens() -> [String?] { mutationTokens }
    func list(appId: String) async throws -> [StorageSuiteInfo] {
        operations.append("list:\(appId)")
        return []
    }

    func entries(appId: String, suiteName: String) async throws -> [StorageEntry] {
        operations.append("entries:\(appId):\(suiteName)")
        return []
    }

    func get(appId: String, suiteName: String, key: String) async throws -> StorageEntry? {
        operations.append("get:\(appId):\(suiteName):\(key)")
        return StorageEntry(key: key, value: "42", type: "INT")
    }

    func set(
        appId: String,
        suiteName: String,
        key: String,
        value: String,
        type: String,
        sessionId: String?,
        mutationToken: String?
    )
        async throws
    {
        mutationTokens.append(mutationToken)
        operations.append("set:\(appId):\(suiteName):\(key):\(value):\(type):\(sessionId ?? "nil")")
    }

    func remove(
        appId: String,
        suiteName: String,
        key: String,
        sessionId: String?,
        mutationToken: String?
    )
        async throws
    {
        mutationTokens.append(mutationToken)
        operations.append("remove:\(appId):\(suiteName):\(key):\(sessionId ?? "nil")")
    }

    func clear(appId: String, suiteName: String, sessionId: String?, mutationToken: String?) async throws {
        mutationTokens.append(mutationToken)
        operations.append("clear:\(appId):\(suiteName):\(sessionId ?? "nil")")
    }
}

private final class RunnerStorageTrap: StorageInspecting, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls = 0
    var calls: Int { lock.lock(); defer { lock.unlock() }; return _calls }
    private func record() { lock.lock(); _calls += 1; lock.unlock() }
    func listSuites() -> [StorageSuiteInfo] { record(); return [] }
    func getEntries(suiteName _: String?) -> [StorageEntry] { record(); return [] }
    func getEntry(suiteName _: String?, key _: String) -> StorageEntry? { record(); return nil }
    func setEntry(suiteName _: String?, key _: String, value _: String?, type _: String) throws { record() }
    func removeEntry(suiteName _: String?, key _: String) throws { record() }
    func clearEntries(suiteName _: String?) throws { record() }
}

@MainActor
final class StorageRoutingTests: XCTestCase {
    private func handler(
        foreground: String = "com.example.app",
        sdkBundle: String? = "com.example.app",
        client: RecordingPreferenceClient,
        runner: RunnerStorageTrap
    )
        -> CommandHandler
    {
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = foreground
        return CommandHandler(
            elementLocator: locator,
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            storageInspector: runner,
            sdkHierarchyClient: PreferenceHierarchyServer(bundleId: sdkBundle),
            sdkPreferenceClient: client
        )
    }

    private func request(_ type: String, fields: [String: Any] = [:]) throws -> WebSocketRequest {
        var payload = fields
        payload["type"] = type
        payload["requestId"] = "storage-test"
        payload["appId"] = "com.example.app"
        return try JSONDecoder().decode(WebSocketRequest.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    func testRoutesAllOperationsToSdkAndNeverUsesRunnerStorage() async throws {
        let client = RecordingPreferenceClient()
        let runner = RunnerStorageTrap()
        let handler = handler(client: client, runner: runner)
        let suite = "duoStore"
        let fields: [String: Any] = ["fileName": suite, "key": "kvDuo"]
        let set = try await handler.handle(request(
            "set_preference",
            fields: fields.merging([
                "value": "42",
                "valueType": "INT",
                "sessionId": "session-1",
                "mutationToken": "launch-token",
            ]) { _, new in new }
        ))
        XCTAssertEqual((set as? WebSocketResponse)?.success, true)
        let get = try await handler.handle(request("get_preference", fields: fields))
        XCTAssertEqual((get as? StorageEntryResponse)?.value, "42")
        _ = try await handler.handle(request("get_preferences", fields: ["fileName": suite]))
        let listing = try await handler.handle(request("list_preference_files")) as? StorageFilesResponse
        XCTAssertEqual(listing?.files?.count, 0)
        _ = try await handler.handle(request(
            "remove_preference",
            fields: fields.merging(["sessionId": "session-1", "mutationToken": "launch-token"]) { _, new in new }
        ))
        _ = try await handler.handle(request(
            "clear_preferences",
            fields: ["fileName": suite, "sessionId": "session-1", "mutationToken": "launch-token"]
        ))
        let calls = await client.recorded()
        XCTAssertEqual(calls, [
            "set:com.example.app:duoStore:kvDuo:42:INT:session-1",
            "get:com.example.app:duoStore:kvDuo",
            "entries:com.example.app:duoStore",
            "list:com.example.app",
            "remove:com.example.app:duoStore:kvDuo:session-1",
            "clear:com.example.app:duoStore:session-1",
        ])
        let tokens = await client.recordedTokens()
        XCTAssertEqual(tokens, ["launch-token", "launch-token", "launch-token"])
        XCTAssertEqual(runner.calls, 0)
    }

    func testMissingSdkFailsWithoutRunnerWrite() async throws {
        let client = RecordingPreferenceClient()
        let runner = RunnerStorageTrap()
        let handler = handler(sdkBundle: nil, client: client, runner: runner)
        let result = try await handler.handle(request("set_preference", fields: [
            "fileName": "duoStore", "key": "kvDuo", "value": "42", "valueType": "INT",
        ])) as? WebSocketResponse
        XCTAssertEqual(result?.success, false)
        XCTAssertTrue(result?.error?.contains("embed and initialize the AutoMobile SDK") == true)
        let calls = await client.recorded()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(runner.calls, 0)
    }
}
