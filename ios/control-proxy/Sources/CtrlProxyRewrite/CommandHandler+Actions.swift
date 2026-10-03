import Foundation

extension CommandHandler {
    // MARK: - Actions

    func handleAction(_ request: RequestAction, startTime: Date) async throws -> WebSocketResponse {
        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.gesturePerformer.performAction(
                request.action, resourceId: request.resourceId, label: request.label,
                bounds: request.bounds, duration: request.duration
            )
        }

        return WebSocketResponse.success(
            type: ResponseType.actionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleActivateAccessibilityLink(
        _ request: RequestActivateAccessibilityLink,
        startTime: Date
    )
        async throws -> WebSocketResponse
    {
        // Prefer the in-app SDK's per-link geometry: it is the only source that can
        // disambiguate duplicate inline links and see SwiftUI inline links, which
        // XCUITest's `.link` query cannot (issue #5560). Occurrence is per owner;
        // owner-less SDK requests select the first matching owner and report a note
        // when several qualify. Unresolved requests retain the XCUITest fallback,
        // which refuses owner-less occurrence > 0 because it cannot group owners.
        let fresh: SdkViewHierarchy? = if await sdkServerMatchesTrackedForegroundApp() {
            await sdkHierarchyClient?.fetchFreshHierarchy()
        } else {
            nil
        }
        let resolution = SemanticLinkActivation.coordinate(
            in: fresh,
            ownerResourceId: request.ownerResourceId,
            text: request.text,
            occurrence: request.occurrence
        )
        try await performContextCheckedGesture(expected: request.frameContext) {
            if let coordinate = resolution?.coordinate {
                try self.gesturePerformer.tap(x: coordinate.x, y: coordinate.y, duration: 0)
            } else {
                try self.gesturePerformer.activateAccessibilityLink(
                    text: request.text,
                    occurrence: request.occurrence,
                    ownerResourceId: request.ownerResourceId
                )
            }
        }
        return WebSocketResponse.success(
            type: ResponseType.actionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime),
            warning: resolution?.ownerNote
        )
    }

    func handleLaunchApp(_ request: RequestLaunchApp, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleLaunchApp")
        defer { perf.end() }

        let bundleId = request.bundleId
        let coldBoot = request.coldBoot ?? false

        // Check current app state to decide launch strategy.
        let appState = await trackedAsync("checkAppState") {
            await self.elementLocator.getAppState(bundleId: bundleId)
        }

        let strategy: String
        let alreadyForeground = appState == .runningForeground
        if coldBoot {
            strategy = appState == .notRunning || appState == .unknown ? "coldBoot:launch" : "coldBoot:terminate+launch"
        } else {
            switch appState {
            case .runningForeground: strategy = "activate(foreground)"
            case .runningBackground, .runningBackgroundSuspended: strategy = "activate(background)"
            default: strategy = "launch(notRunning)"
            }
        }
        print("[CtrlProxy] handleLaunchApp bundleId=\(bundleId) appState=\(appState) strategy=\(strategy)")

        if coldBoot {
            // Cold boot: always terminate then launch fresh.
            if appState == .runningForeground || appState == .runningBackground || appState ==
                .runningBackgroundSuspended
            {
                try await trackedAsync("terminateApp") {
                    try await self.gesturePerformer.terminateApp(bundleId: bundleId)
                }
            }
            try await trackedAsync("launchApp") {
                try await self.gesturePerformer.launchApp(bundleId: bundleId)
            }
        } else if appState == .runningForeground {
            // Already in foreground — activate is a no-op but ensures XCTest sync.
            try await trackedAsync("activateApp") {
                try await self.gesturePerformer.activateApp(bundleId: bundleId)
            }
        } else if appState == .runningBackground || appState == .runningBackgroundSuspended {
            // App running but not visible — activate brings to foreground (fast path).
            try await trackedAsync("activateApp") {
                try await self.gesturePerformer.activateApp(bundleId: bundleId)
            }
        } else {
            // App not running — must do full launch.
            try await trackedAsync("launchApp") {
                try await self.gesturePerformer.launchApp(bundleId: bundleId)
            }
        }

        // Explicit state transition: switch tracking to launched app.
        await trackedAsync("switchForegroundApp") {
            await self.elementLocator.switchForegroundApp(bundleId: bundleId)
        }
        await trackedAsync("updateApplication") {
            await self.gesturePerformer.updateApplication(bundleId: bundleId)
        }

        // Skip foreground poll when activate() was called on an already-foreground app —
        // activate() is synchronous and the app is guaranteed to remain foreground.
        if !alreadyForeground || coldBoot {
            await trackedAsync("awaitForeground") {
                _ = await self.elementLocator.awaitAppState(bundleId: bundleId, expectedState: .foreground)
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.launchAppResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    // MARK: - App Privacy Permissions

    /// Reset privacy authorizations for an app to not-determined. An empty `permissions`
    /// array is rejected so the client gets an actionable error instead of a silent success;
    /// an unmapped resource throws from the gesture performer and surfaces via the catch (#2491).
    func handleResetPermissions(_ request: RequestResetPermissions, startTime: Date) async throws
        -> WebSocketResponse
    {
        guard !request.permissions.isEmpty else {
            throw CommandError.missingParameter("permissions")
        }
        try await gesturePerformer.resetAuthorizations(bundleId: request.bundleId, resources: request.permissions)
        return WebSocketResponse.success(
            type: ResponseType.resetPermissionsResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }
}
