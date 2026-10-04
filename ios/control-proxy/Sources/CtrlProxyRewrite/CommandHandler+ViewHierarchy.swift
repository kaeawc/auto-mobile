import Foundation

extension CommandHandler {
    // MARK: - View Hierarchy

    func captureHierarchy(disableAllFiltering: Bool = false) async throws -> ViewHierarchy {
        try await captureAndRecordHierarchy(disableAllFiltering: disableAllFiltering)
    }

    /// Capture and record in one actor turn, with no suspension between the two.
    /// Record only the raw filtered capture: SDK refreshes enrich it at publication time.
    /// Recording is non-throwing and changes no polling or broadcast state.
    @MainActor
    private func captureAndRecordHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy {
        let captureSequence = disableAllFiltering ? nil : hierarchyDebouncer?.beginCapture()
        let hierarchy = try elementLocator.getViewHierarchy(disableAllFiltering: disableAllFiltering)
        if let captureSequence {
            hierarchyDebouncer?.recordCommandCapture(hierarchy, captureSequence: captureSequence)
        }
        return hierarchy
    }

    func handleSetHierarchyPollInterval(
        _ request: RequestSetHierarchyPollInterval,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        guard request.intervalMs > 0 else {
            throw CommandError.invalidParameter("intervalMs", String(request.intervalMs))
        }
        await hierarchyDebouncer?.updatePollIntervalMs(request.intervalMs)
        return WebSocketResponse.success(
            type: ResponseType.setHierarchyPollIntervalResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleRequestHierarchy(
        _ request: RequestHierarchy,
        startTime _: Date
    )
        async throws -> HierarchyUpdateResponse
    {
        perf.serial("handleRequestHierarchy")
        defer { perf.end() }

        let disableAllFiltering = request.disableAllFiltering ?? false
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try await trackedAsync("extraction") {
                try await self.captureHierarchy(disableAllFiltering: disableAllFiltering)
            }
        } catch {
            print("[CommandHandler] Hierarchy extraction failed: \(error)")
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }

        let enriched = await enrichWithMatchingSdkHierarchy(hierarchy)

        // Snapshot this operation without closing the outer request span or draining pooled roots.
        let perfTiming = perf.snapshot("handleRequestHierarchy")

        return HierarchyUpdateResponse(
            requestId: request.requestId,
            data: enriched,
            perfTiming: perfTiming,
            frameContext: frameContext.context(for: enriched)
        )
    }

    func enrichWithMatchingSdkHierarchy(_ hierarchy: ViewHierarchy) async -> ViewHierarchy {
        let sdk = await matchingSdkHierarchy(for: hierarchy)
        return HierarchyMerger.merge(xcuitest: hierarchy, sdk: sdk)
    }

    func enrichWithCachedSdkHierarchy(_ hierarchy: ViewHierarchy) -> ViewHierarchy {
        HierarchyMerger.merge(xcuitest: hierarchy, sdk: matchingCachedSdkHierarchy(for: hierarchy))
    }

    /// The cached-only read path (gestures, screenshots, accessibility). Uses the cache's
    /// transactional `reconcile` — read → compare → clear in one `withLock` — closing race #2
    /// (STATUS §6). Behaviorally identical to the reference's `latest` + conditional `clear`
    /// (clearing an empty cache is a no-op).
    private func matchingCachedSdkHierarchy(for hierarchy: ViewHierarchy) -> SdkViewHierarchy? {
        guard let foregroundBundleId = normalizedBundleId(hierarchy.packageName) else {
            return nil
        }
        return sdkHierarchyCache?.reconcile(matchingBundleId: foregroundBundleId)
    }

    /// The refresh path (`request_hierarchy`). A background SDK may still listen on its
    /// port without answering, so only probe when its app is actually foreground.
    private func matchingSdkHierarchy(for hierarchy: ViewHierarchy) async -> SdkViewHierarchy? {
        guard let foregroundBundleId = normalizedBundleId(hierarchy.packageName) else {
            return nil
        }

        let cached = sdkHierarchyCache?.latest
        // Preserve an invalid cached bundle as a mismatch rather than treating it as no cache.
        let cachedBundleId = cached.map { normalizedBundleId($0.bundleId) ?? "" }
        let appState: ObservedAppState?
        if foregroundBundleId == "com.apple.springboard" ||
            (cached != nil && cachedBundleId != foregroundBundleId) ||
            (cached == nil && sdkHierarchyClient == nil)
        {
            appState = nil
        } else {
            appState = await elementLocator.getAppState(bundleId: foregroundBundleId)
        }

        switch SdkHierarchyProbeDecision.decide(
            foregroundBundleId: foregroundBundleId,
            cachedBundleId: cachedBundleId,
            appState: appState
        ) {
        case .clear:
            sdkHierarchyCache?.clear()
            return nil
        case .skip:
            return cached
        case .probe:
            break
        }

        guard await sdkServerMatchesForegroundBundleId(foregroundBundleId) else {
            return nil
        }

        guard let fresh = await sdkHierarchyClient?.fetchFreshHierarchy(),
              sdkHierarchy(fresh, matches: foregroundBundleId)
        else {
            sdkHierarchyCache?.clear()
            return nil
        }
        sdkHierarchyCache?.update(fresh)
        return fresh
    }

    private func sdkServerMatchesForegroundBundleId(_ foregroundBundleId: String) async -> Bool {
        guard let serverBundleId = normalizedBundleId(await sdkHierarchyClient?.fetchServerInfo()?.bundleId) else {
            return false
        }
        return serverBundleId == foregroundBundleId
    }

    func sdkServerMatchesTrackedForegroundApp() async -> Bool {
        await sdkServerInfoForTrackedForegroundApp() != nil
    }

    func sdkServerInfoForTrackedForegroundApp() async -> SdkHierarchyServerInfo? {
        guard let foregroundBundleId = normalizedBundleId(await elementLocator.refreshForegroundBundleId()) else {
            return nil
        }
        guard let serverInfo = await sdkHierarchyClient?.fetchServerInfo(),
              normalizedBundleId(serverInfo.bundleId) == foregroundBundleId
        else {
            return nil
        }
        return serverInfo
    }

    private func sdkHierarchy(_ sdkHierarchy: SdkViewHierarchy, matches foregroundBundleId: String) -> Bool {
        normalizedBundleId(sdkHierarchy.bundleId) == foregroundBundleId
    }

    func normalizedBundleId(_ bundleId: String?) -> String? {
        guard let normalized = bundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalized.isEmpty
        else {
            return nil
        }
        return normalized
    }

    func handleRequestScreenshot(
        _ request: RequestEnvelope,
        startTime _: Date
    )
        async throws -> ScreenshotResponse
    {
        // Frame-context correlation is opt-in: only when the client supplies a `frameContext`
        // does the screenshot pay for the surrounding hierarchy walks. A plain screenshot
        // performs zero extractions and returns `frameContext: nil`.
        //
        // When requested, read the hierarchy on both sides of the pixel capture. A change
        // during capture leaves the context absent, which makes a context-aware client fail
        // closed instead of pairing pixels from one screen with the identity of another.
        let correlate = request.frameContext != nil
        let before = correlate ? await currentFrameContext() : nil
        let screenshot = try await gesturePerformer.getScreenshotCapture()
        let after = correlate ? await currentFrameContext() : nil
        let base64 = screenshot.data.base64EncodedString()

        return ScreenshotResponse(
            requestId: request.requestId,
            data: base64,
            format: "png",
            rotation: screenshot.rotation,
            frameContext: correlate && before == after ? before : nil
        )
    }

    private func currentFrameContext() async -> String? {
        guard let hierarchy = try? await captureHierarchy() else {
            return nil
        }
        return frameContext.context(for: enrichWithCachedSdkHierarchy(hierarchy))
    }
}
