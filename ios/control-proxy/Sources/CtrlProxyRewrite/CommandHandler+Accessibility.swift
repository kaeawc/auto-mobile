import Foundation

extension CommandHandler {
    // MARK: - Accessibility Features

    /// Report the element holding the VoiceOver cursor. The cursor is only visible in-process,
    /// so it reaches us as `accessibility-focused` on the SDK-enriched hierarchy (see
    /// HierarchyMerger, #3924). A null focusedElement is a success, not an error.
    func handleGetCurrentFocus(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async throws -> CurrentFocusResponse
    {
        let enriched = try await enrichedHierarchyForAccessibility()
        let focused = enriched.hierarchy.flatMap { Self.findAccessibilityFocused($0) }
        return CurrentFocusResponse(
            requestId: request.requestId,
            focusedElement: focused,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Report accessibility elements in VoiceOver traversal (depth-first) order, plus the
    /// index of the focused one when the cursor is present (#3924).
    func handleGetTraversalOrder(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async throws -> TraversalOrderResponse
    {
        let enriched = try await enrichedHierarchyForAccessibility()
        var ordered: [UIElementInfo] = []
        if let root = enriched.hierarchy {
            Self.collectAccessibilityElements(root, into: &ordered)
        }
        let focusedIndex = ordered.firstIndex { $0.accessibilityFocused == "true" }
        return TraversalOrderResponse(
            requestId: request.requestId,
            elements: ordered,
            focusedIndex: focusedIndex,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Extract the hierarchy and merge the in-app SDK view tree into it, so accessibility-only
    /// signals (the VoiceOver cursor, `isAccessibilityElement`) are present.
    private func enrichedHierarchyForAccessibility() async throws -> ViewHierarchy {
        let hierarchy: ViewHierarchy
        do {
            hierarchy = try await trackedAsync("extraction") {
                try await self.captureHierarchy()
            }
        } catch {
            throw CommandError.executionFailed("Failed to get view hierarchy: \(error.localizedDescription)")
        }
        return await enrichWithMatchingSdkHierarchy(hierarchy)
    }

    /// Depth-first search for the element carrying the VoiceOver cursor.
    static func findAccessibilityFocused(_ element: UIElementInfo) -> UIElementInfo? {
        if element.accessibilityFocused == "true" {
            return element
        }
        for child in element.node ?? [] {
            if let match = findAccessibilityFocused(child) {
                return match
            }
        }
        return nil
    }

    /// Collect, depth-first, the elements VoiceOver would stop on. `isAccessibilityElement`
    /// is the precise signal, carried through from the in-app SDK; containers that merely
    /// hold other elements are skipped but still traversed into.
    static func collectAccessibilityElements(_ element: UIElementInfo, into ordered: inout [UIElementInfo]) {
        if element.extras?["sdk.isAccessibilityElement"] == "true" {
            ordered.append(element)
        }
        for child in element.node ?? [] {
            collectAccessibilityElements(child, into: &ordered)
        }
    }

    func handleAddHighlight(_ request: RequestAddHighlight, startTime: Date) async -> WebSocketResponse {
        guard let shape = request.shape else {
            return WebSocketResponse.error(
                type: ResponseType.highlightResponse.rawValue,
                requestId: request.requestId,
                error: "add_highlight requires a shape",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        let highlightId = request.id ?? request.requestId ?? UUID().uuidString
        // When the in-app SDK bridge owns the foreground app, it is the authoritative (and
        // only) highlight path. A rejection there — e.g. missing source dimensions (#2682) —
        // must be reported precisely rather than collapsed into the generic "SDK not embedded"
        // error below, which would mislead since the SDK is in fact embedded. An unreachable
        // bridge falls through to that generic error.
        if sdkHierarchyClient != nil, await sdkServerMatchesTrackedForegroundApp() {
            switch await sdkHierarchyClient?.addHighlight(id: highlightId, shape: shape) {
            case .rendered:
                return WebSocketResponse.success(
                    type: ResponseType.highlightResponse.rawValue,
                    requestId: request.requestId,
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            case .rejected:
                return WebSocketResponse.error(
                    type: ResponseType.highlightResponse.rawValue,
                    requestId: request.requestId,
                    error: "Target app SDK highlight bridge rejected the highlight "
                        + "(missing source dimensions or invalid shape).",
                    totalTimeMs: totalTimeMs(from: startTime)
                )
            case .unavailable, .none:
                break // Bridge unreachable — fall through to the SDK-required error.
            }
        }
        // iOS cannot draw an overlay into another app from the test runner: the runner's own
        // UIWindow only composites while the runner is foreground, which never happens during
        // automation. Highlighting the app-under-test requires the in-app AutoMobile SDK bridge.
        let foregroundBundleId = await elementLocator.foregroundBundleId ?? "the foreground app"
        return WebSocketResponse.error(
            type: ResponseType.highlightResponse.rawValue,
            requestId: request.requestId,
            error: "Highlighting \(foregroundBundleId) requires the AutoMobile SDK embedded in the target app; "
                + "iOS cannot draw an overlay into another app from the test runner.",
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleGetVoiceOverState(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async -> VoiceOverStateResponse
    {
        guard let enabled = voiceOverStateProvider.isVoiceOverRunning() else {
            return VoiceOverStateResponse(
                requestId: request.requestId,
                unreadableWithTotalTimeMs: totalTimeMs(from: startTime)
            )
        }

        return VoiceOverStateResponse(
            requestId: request.requestId,
            enabled: enabled,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Enable/disable VoiceOver on a physical device by driving Settings (#2501).
    /// The toggle reads the switch value and skips the tap when it already matches.
    func handleSetVoiceOverState(
        _ request: RequestSetVoiceOverState,
        startTime: Date
    )
        async -> VoiceOverSetResponse
    {
        let enabled = request.enabled

        do {
            // `setVoiceOver` is `@MainActor` (it drives XCUITest); `await` hops this async
            // `Sendable` handler onto the main actor, like its other UI-collaborator calls.
            try await voiceOverToggle.setVoiceOver(enabled: enabled)
            return VoiceOverSetResponse(
                requestId: request.requestId,
                success: true,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return VoiceOverSetResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }

    func handleSetHingeAngle(
        _ request: RequestSetHingeAngle,
        startTime: Date
    )
        async -> HingeAngleResponse
    {
        guard request.angle.isFinite, (0 ... 180).contains(request.angle) else {
            return HingeAngleResponse(
                requestId: request.requestId,
                success: false,
                error: "Hinge angle must be a finite number from 0 to 180 degrees.",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        do {
            try await hingeAngleSetter.setHingeAngle(request.angle)
            return HingeAngleResponse(
                requestId: request.requestId,
                success: true,
                angle: request.angle,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        } catch {
            return HingeAngleResponse(
                requestId: request.requestId,
                success: false,
                error: error.localizedDescription,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
    }
}
