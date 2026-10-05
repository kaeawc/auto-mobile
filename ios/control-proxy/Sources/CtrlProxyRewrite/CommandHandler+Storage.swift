import Foundation

extension CommandHandler {
    // MARK: - Storage

    private static let preferenceSdkNotDispatchedCode = "sdk_unavailable_not_dispatched"

    /// A localhost SDK server may belong to a different foreground app. Check both
    /// the requested bundle and the server owner before any preference operation.
    private func preferenceClient(_ requested: String?) async throws -> (String, any SdkPreferenceFetching) {
        guard let appId = normalizedBundleId(requested) else {
            throw CommandError.missingParameter("appId")
        }
        guard normalizedBundleId(await elementLocator.refreshForegroundBundleId()) == appId else {
            throw CommandError.executionFailed("iOS key-value storage requires \(appId) to be the foreground app")
        }
        guard normalizedBundleId(await sdkHierarchyClient?.fetchServerInfo()?.bundleId) == appId else {
            throw CommandError.executionFailed(
                "iOS key-value storage requires \(appId) to embed and initialize the AutoMobile SDK "
                    + "and call UserDefaultsInspector.shared.setEnabled(true): \(Self.preferenceSdkNotDispatchedCode)"
            )
        }
        guard let client = sdkPreferenceClient else {
            throw CommandError.executionFailed(
                "iOS key-value storage requires the target app to embed the AutoMobile SDK: "
                    + Self.preferenceSdkNotDispatchedCode
            )
        }
        return (appId, client)
    }

    func handleListPreferenceFiles(_ request: RequestEnvelope, startTime: Date) async -> StorageFilesResponse {
        do {
            let (appId, client) = try await preferenceClient(request.appId)
            let files = try await client.list(appId: appId)
            return StorageFilesResponse(
                requestId: request.requestId,
                success: true,
                files: files,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return StorageFilesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleGetPreferences(
        _ request: RequestGetPreferences,
        startTime: Date
    )
        async -> StorageEntriesResponse
    {
        do {
            let (appId, client) = try await preferenceClient(request.appId)
            let entries = try await client.entries(appId: appId, suiteName: request.fileName ?? "Standard")
            return StorageEntriesResponse(
                requestId: request.requestId,
                success: true,
                entries: entries,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return StorageEntriesResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleGetPreference(_ request: RequestGetPreference, startTime: Date) async -> StorageEntryResponse {
        do {
            let (appId, client) = try await preferenceClient(request.appId)
            guard let key = request.key else { throw CommandError.missingParameter("key") }
            let entry = try await client.get(appId: appId, suiteName: request.fileName ?? "Standard", key: key)
            return StorageEntryResponse(
                requestId: request.requestId,
                success: true,
                found: entry != nil,
                key: entry?.key,
                value: entry?.value,
                valueType: entry?.type,
                totalTimeMs: totalTimeMs(from: startTime),
                redacted: entry?.redacted
            )
        } catch {
            return StorageEntryResponse(
                requestId: request.requestId,
                success: false,
                found: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleSetPreference(
        _ request: RequestSetPreference,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        let (appId, client) = try await preferenceClient(request.appId)
        let result: PreferenceMutationResult
        if let value = request.value {
            result = try await client.set(
                appId: appId,
                suiteName: request.fileName ?? "Standard",
                key: request.key,
                value: value,
                type: request.valueType,
                sessionId: request.sessionId,
                mutationToken: request.mutationToken
            )
        } else {
            result = try await client.remove(
                appId: appId,
                suiteName: request.fileName ?? "Standard",
                key: request.key,
                sessionId: request.sessionId,
                mutationToken: request.mutationToken
            )
        }
        var response = WebSocketResponse.success(
            type: ResponseType.setPreferenceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            resolvedStore: result.resolvedStore
        )
        if request.value != nil { response.effectiveValueDiffers = result.effectiveValueDiffers }
        return response
    }

    func handleRemovePreference(
        _ request: RequestRemovePreference,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        let (appId, client) = try await preferenceClient(request.appId)
        let result = try await client.remove(
            appId: appId,
            suiteName: request.fileName ?? "Standard",
            key: request.key,
            sessionId: request.sessionId,
            mutationToken: request.mutationToken
        )
        return WebSocketResponse.success(
            type: ResponseType.removePreferenceResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            resolvedStore: result.resolvedStore
        )
    }

    func handleClearPreferences(
        _ request: RequestClearPreferences,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        let (appId, client) = try await preferenceClient(request.appId)
        let result = try await client.clear(
            appId: appId,
            suiteName: request.fileName ?? "Standard",
            sessionId: request.sessionId,
            mutationToken: request.mutationToken
        )
        return WebSocketResponse.success(
            type: ResponseType.clearPreferencesResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            resolvedStore: result.resolvedStore
        )
    }
}
