@testable import CtrlProxy
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
    private let resolvedStore: String?
    private let effectiveValueDiffers: Bool?
    private let redacted: Bool?
    private let storedEntries: [StorageEntry]
    init(
        resolvedStore: String? = "standard",
        effectiveValueDiffers: Bool? = nil,
        redacted: Bool? = nil,
        entries: [StorageEntry] = []
    ) {
        self.resolvedStore = resolvedStore
        self.effectiveValueDiffers = effectiveValueDiffers
        self.redacted = redacted
        storedEntries = entries
    }

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
        return storedEntries
    }

    func get(appId: String, suiteName: String, key: String) async throws -> StorageEntry? {
        operations.append("get:\(appId):\(suiteName):\(key)")
        return StorageEntry(key: key, value: "42", type: "INT", redacted: redacted)
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
        async throws -> PreferenceMutationResult
    {
        mutationTokens.append(mutationToken)
        operations.append("set:\(appId):\(suiteName):\(key):\(value):\(type):\(sessionId ?? "nil")")
        return PreferenceMutationResult(resolvedStore: resolvedStore, effectiveValueDiffers: effectiveValueDiffers)
    }

    func remove(
        appId: String,
        suiteName: String,
        key: String,
        sessionId: String?,
        mutationToken: String?
    )
        async throws -> PreferenceMutationResult
    {
        mutationTokens.append(mutationToken)
        operations.append("remove:\(appId):\(suiteName):\(key):\(sessionId ?? "nil")")
        return PreferenceMutationResult(resolvedStore: resolvedStore, effectiveValueDiffers: effectiveValueDiffers)
    }

    func clear(
        appId: String,
        suiteName: String,
        sessionId: String?,
        mutationToken: String?
    )
        async throws -> PreferenceMutationResult
    {
        mutationTokens.append(mutationToken)
        operations.append("clear:\(appId):\(suiteName):\(sessionId ?? "nil")")
        return PreferenceMutationResult(resolvedStore: resolvedStore, effectiveValueDiffers: effectiveValueDiffers)
    }
}

@MainActor
final class StorageRoutingTests: XCTestCase {
    private func handler(
        foreground: String = "com.example.app",
        sdkBundle: String? = "com.example.app",
        client: RecordingPreferenceClient?
    )
        -> CommandHandler
    {
        let locator = FakeElementLocator()
        locator.foregroundBundleId = foreground
        return CommandHandler(
            elementLocator: locator,
            gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(),
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

    func testRoutesAllOperationsToSdkPreferenceClient() async throws {
        let client = RecordingPreferenceClient()
        let handler = handler(client: client)
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
        XCTAssertEqual((set as? WebSocketResponse)?.resolvedStore, "standard")
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
    }

    func testGetPreferenceEncodesRedactedFlagAndPreservesNormalWireOutput() async throws {
        let redactedHandler = handler(
            client: RecordingPreferenceClient(redacted: true)
        )
        let redactedResponse = try await redactedHandler.handle(request("get_preference", fields: ["key": "token"]))
        let redactedEntryResponse = try XCTUnwrap(redactedResponse as? StorageEntryResponse)
        let redactedBody = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(redactedEntryResponse)) as? [String: Any]
        )
        XCTAssertEqual(redactedBody["redacted"] as? Bool, true)
        XCTAssertEqual(redactedBody["key"] as? String, "token")
        XCTAssertEqual(redactedBody["value"] as? String, "42")
        XCTAssertEqual(redactedBody["valueType"] as? String, "INT")

        for redacted in [nil, false] as [Bool?] {
            let normalHandler = handler(
                client: RecordingPreferenceClient(redacted: redacted)
            )
            let response = try await normalHandler.handle(request("get_preference", fields: ["key": "token"]))
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let entryResponse = try XCTUnwrap(response as? StorageEntryResponse)
            let encodedData = try encoder.encode(entryResponse)
            let encoded = try XCTUnwrap(String(data: encodedData, encoding: .utf8))
            let body = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
            )
            XCTAssertNil(body["redacted"])
            let timestamp = try XCTUnwrap(body["timestamp"])
            let totalTimeMs = try XCTUnwrap(body["totalTimeMs"])
            let expected = "{\"found\":true,\"key\":\"token\",\"requestId\":\"storage-test\","
                + "\"success\":true,\"timestamp\":\(timestamp),\"totalTimeMs\":\(totalTimeMs),"
                + "\"type\":\"get_preference_result\",\"value\":\"42\",\"valueType\":\"INT\"}"
            XCTAssertEqual(encoded, expected)
        }
    }

    func testGetPreferencesOnlyEncodesRedactedFlagOnRedactedEntries() async throws {
        let client = RecordingPreferenceClient(entries: [
            StorageEntry(key: "token", value: "[REDACTED]", type: "STRING", redacted: true),
            StorageEntry(key: "theme", value: "dark", type: "STRING"),
            StorageEntry(key: "legacy", value: "value", type: "STRING", redacted: false),
        ])
        let handler = handler(client: client)
        let result = try await handler.handle(request("get_preferences"))
        let response = try XCTUnwrap(result as? StorageEntriesResponse)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(response)) as? [String: Any])
        let entries = try XCTUnwrap(body["entries"] as? [[String: Any]])
        XCTAssertEqual(entries[0]["redacted"] as? Bool, true)
        XCTAssertNil(entries[1]["redacted"])
        XCTAssertNil(entries[2]["redacted"])
    }

    func testMissingSdkFailsWithoutDispatch() async throws {
        for sdkBundle in [nil, "com.other.app"] as [String?] {
            let client = RecordingPreferenceClient()
            let handler = handler(sdkBundle: sdkBundle, client: client)
            let expected = "Command execution failed: iOS key-value storage requires com.example.app "
                + "to embed and initialize the AutoMobile SDK and call UserDefaultsInspector.shared.setEnabled(true)"
                + ": sdk_unavailable_not_dispatched"
            for type in ["set_preference", "remove_preference", "clear_preferences"] {
                let result = try await handler.handle(request(type, fields: [
                    "fileName": "duoStore", "key": "kvDuo", "value": "42", "valueType": "INT",
                ])) as? WebSocketResponse
                XCTAssertEqual(result?.success, false)
                XCTAssertEqual(result?.error, expected)
            }
            let read = try await handler.handle(request("get_preference", fields: ["key": "kvDuo"]))
                as? StorageEntryResponse
            XCTAssertEqual(read?.success, false)
            XCTAssertEqual(read?.error, expected)
            let calls = await client.recorded()
            XCTAssertEqual(calls, [])
        }
    }

    func testMissingPreferenceClientFailsBeforeDispatch() async throws {
        let handler = handler(client: nil)
        let expected = "Command execution failed: iOS key-value storage requires the target app "
            + "to embed the AutoMobile SDK: sdk_unavailable_not_dispatched"
        for type in ["set_preference", "remove_preference", "clear_preferences"] {
            let result = try await handler.handle(request(type, fields: [
                "fileName": "duoStore", "key": "kvDuo", "value": "42", "valueType": "INT",
            ])) as? WebSocketResponse
            XCTAssertEqual(result?.success, false)
            XCTAssertEqual(result?.error, expected)
        }
        let read = try await handler.handle(request("get_preference", fields: ["key": "kvDuo"]))
            as? StorageEntryResponse
        XCTAssertEqual(read?.success, false)
        XCTAssertEqual(read?.error, expected)
    }

    func testForegroundRefusalRemainsUnmarked() async throws {
        let client = RecordingPreferenceClient()
        let handler = handler(foreground: "com.other.app", client: client)
        let result = try await handler.handle(request("set_preference", fields: [
            "key": "kvDuo", "value": "42", "valueType": "INT",
        ])) as? WebSocketResponse
        XCTAssertEqual(result?.success, false)
        XCTAssertEqual(
            result?.error,
            "Command execution failed: iOS key-value storage requires com.example.app to be the foreground app"
        )
        let calls = await client.recorded()
        XCTAssertEqual(calls, [])
    }

    func testMutationResponsesForwardResolutionAndOmitItForOlderSdk() async throws {
        for resolvedStore in ["standard", nil] as [String?] {
            let handler = handler(
                client: RecordingPreferenceClient(resolvedStore: resolvedStore)
            )
            for type in ["set_preference", "remove_preference", "clear_preferences"] {
                let result = try await handler.handle(request(type, fields: [
                    "fileName": "standard", "key": "key", "value": "42", "valueType": "INT",
                ]))
                let response = try XCTUnwrap(result as? WebSocketResponse)
                XCTAssertEqual(response.success, true)
                XCTAssertEqual(response.resolvedStore, resolvedStore)
                let body = try XCTUnwrap(
                    JSONSerialization
                        .jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
                )
                XCTAssertEqual(body["resolvedStore"] as? String, resolvedStore)
                if resolvedStore == nil { XCTAssertNil(body["resolvedStore"]) }
            }
            let removed = try await handler.handle(request("set_preference", fields: [
                "fileName": "standard", "key": "key", "valueType": "STRING",
            ]))
            XCTAssertEqual((removed as? WebSocketResponse)?.resolvedStore, resolvedStore)
        }
    }

    func testOnlySetForwardsEffectiveValueDiffers() async throws {
        let handler = handler(
            client: RecordingPreferenceClient(effectiveValueDiffers: true)
        )
        for type in ["set_preference", "remove_preference", "clear_preferences"] {
            let result = try await handler.handle(request(type, fields: [
                "fileName": "standard", "key": "key", "value": "written", "valueType": "STRING",
            ]))
            let response = try XCTUnwrap(result as? WebSocketResponse)
            XCTAssertEqual(response.effectiveValueDiffers, type == "set_preference" ? true : nil)
            let body = try XCTUnwrap(
                JSONSerialization
                    .jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
            )
            if type != "set_preference" { XCTAssertNil(body["effectiveValueDiffers"]) }
        }
        let removed = try await handler.handle(request("set_preference", fields: [
            "fileName": "standard", "key": "key", "valueType": "STRING",
        ]))
        XCTAssertNil((removed as? WebSocketResponse)?.effectiveValueDiffers)
    }
}
