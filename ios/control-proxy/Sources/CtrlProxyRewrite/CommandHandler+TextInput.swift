import Foundation

extension CommandHandler {
    // MARK: - Text Input

    func handleSetText(_ request: RequestSetText, startTime: Date) async throws -> WebSocketResponse {
        let text = request.text
        let resourceId = request.resourceId

        perf.serial("handleSetText")
        defer { perf.end() }

        do {
            try await performContextCheckedGestureAsync(expected: request.frameContext) {
                if let resourceId {
                    try await self.trackedAsync("setText.byResourceId") {
                        try await self.gesturePerformer.setText(resourceId: resourceId, text: text)
                    }
                } else {
                    try self.tracked("typeText") {
                        try self.gesturePerformer.typeText(text: text)
                    }
                }
            }
        } catch {
            print("[CommandHandler] handleSetText FAILED resourceId=\(resourceId ?? "nil") error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.setTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleAppendText(_ request: RequestAppendText, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleAppendText")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("appendText") {
                try self.gesturePerformer.appendText(text: request.text)
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.appendTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleClearText(_ request: RequestClearText, startTime: Date) async throws -> WebSocketResponse {
        let resourceId = request.resourceId

        perf.serial("handleClearText")
        defer { perf.end() }

        do {
            try await performContextCheckedGestureAsync(expected: request.frameContext) {
                try await self.trackedAsync("clearText") {
                    try await self.gesturePerformer.clearText(resourceId: resourceId)
                }
            }
        } catch {
            print("[CommandHandler] handleClearText FAILED resourceId=\(resourceId ?? "nil") error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.clearTextResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleImeAction(_ request: RequestImeAction, startTime: Date) async throws -> WebSocketResponse {
        let action = request.action

        perf.serial("handleImeAction")
        defer { perf.end() }

        do {
            try await performContextCheckedGesture(expected: request.frameContext) {
                try self.tracked("imeAction") {
                    try self.gesturePerformer.performImeAction(action)
                }
            }
        } catch {
            print("[CommandHandler] handleImeAction FAILED action=\(action) error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.imeActionResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleSelectAll(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleSelectAll")
        defer { perf.end() }

        do {
            try await performContextCheckedGesture(expected: request.frameContext) {
                try self.tracked("selectAll") {
                    try self.gesturePerformer.selectAll()
                }
            }
        } catch {
            print("[CommandHandler] handleSelectAll FAILED error=\(error)")
            throw error
        }

        return WebSocketResponse.success(
            type: ResponseType.selectAllResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleKeyboard(_ request: RequestKeyboard, startTime: Date) async throws -> KeyboardResponse {
        let action = request.action

        perf.serial("handleKeyboard")
        defer { perf.end() }

        let result = try await trackedAsync("keyboard") {
            try await self.gesturePerformer.keyboard(action: action)
        }
        let success = keyboardActionSucceeded(action: action, open: result.open)

        return KeyboardResponse(
            requestId: request.requestId,
            success: success,
            open: result.open,
            totalTimeMs: totalTimeMs(from: startTime),
            error: success ? nil : (result.error ?? "Keyboard did not \(action.lowercased())"),
            method: result.method
        )
    }

    func handlePressKey(_ request: RequestPressKey, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handlePressKey")
        defer { perf.end() }

        let outcome = try await performContextCheckedGestureAsync(expected: request.frameContext) {
            try await self.trackedAsync("pressKey") {
                try await self.gesturePerformer.pressKeyOutcome(key: request.key, modifiers: request.modifiers)
            }
        }

        return WebSocketResponse(
            type: ResponseType.pressKeyResult.rawValue,
            requestId: request.requestId,
            success: true,
            totalTimeMs: totalTimeMs(from: startTime),
            verified: outcome.verified,
            warning: outcome.warning
        )
    }

    private func keyboardActionSucceeded(action: String, open: Bool) -> Bool {
        switch action.lowercased() {
        case "detect":
            return true
        case "open":
            return open
        case "close":
            return !open
        default:
            return false
        }
    }

    func handlePressButton(_ request: RequestPressButton, startTime: Date) async throws -> WebSocketResponse {
        let button = request.action

        perf.serial("handlePressButton")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("pressButton") {
                try self.gesturePerformer.pressButton(button)
            }
        }

        if button.lowercased() == "home" || button.lowercased() == "recent" {
            await trackedAsync("switchForegroundApp") {
                await self.elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
            }
            await trackedAsync("updateApplication") {
                await self.gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.pressButtonResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handlePressHome(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handlePressHome")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("pressHome") {
                try self.gesturePerformer.pressHome()
            }
        }

        // A completed XCUIDevice press can be a no-op on some simulators. Detect
        // foreground before updating the tracked app, or later observations lie.
        guard await elementLocator.refreshForegroundBundleId() == "com.apple.springboard" else {
            return WebSocketResponse.error(
                type: ResponseType.pressHomeResult.rawValue,
                requestId: request.requestId,
                error: "Home press did not bring SpringBoard to the foreground",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        await trackedAsync("switchForegroundApp") {
            await self.elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
        }
        await trackedAsync("updateApplication") {
            await self.gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
        }

        return WebSocketResponse.success(
            type: ResponseType.pressHomeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handlePressBack(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handlePressBack")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("pressBack") {
                try self.gesturePerformer.pressBack()
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.pressBackResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleShake(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleShake")
        defer { perf.end() }

        try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("shake") {
                try self.gesturePerformer.shake()
            }
        }

        return WebSocketResponse.success(
            type: ResponseType.shakeResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleRecentApps(_ request: RequestEnvelope, startTime: Date) async throws -> WebSocketResponse {
        perf.serial("handleRecentApps")
        defer { perf.end() }

        let didOpen = try await performContextCheckedGesture(expected: request.frameContext) {
            try self.tracked("openRecentApps") {
                try self.gesturePerformer.openRecentApps()
            }
        }

        guard didOpen else {
            return WebSocketResponse.error(
                type: ResponseType.recentAppsResult.rawValue,
                requestId: request.requestId,
                error: "iOS App Switcher did not appear after recent apps invocation",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        // Explicit state transition: app switcher is SpringBoard UI.
        await trackedAsync("switchForegroundApp") {
            await self.elementLocator.switchForegroundApp(bundleId: "com.apple.springboard")
        }
        if let locator = elementLocator as? ElementLocator {
            await locator.noteAppSwitcherOpened()
        }
        await trackedAsync("updateApplication") {
            await self.gesturePerformer.updateApplication(bundleId: "com.apple.springboard")
        }

        return WebSocketResponse.success(
            type: ResponseType.recentAppsResult.rawValue,
            requestId: request.requestId,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }
}
