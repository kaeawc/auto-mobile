import Foundation

extension CommandHandler {
    func handleMagicTap(_ request: RequestEnvelope, startTime: Date) async -> MagicTapResponse {
        guard let info = await sdkServerInfoForTrackedForegroundApp(),
              info.capabilities.contains("magic-tap"),
              let client = sdkHierarchyClient
        else {
            return MagicTapResponse(
                requestId: request.requestId, available: false, handled: nil,
                error: "Magic Tap requires the AutoMobile in-app SDK with magic-tap support in the foreground app.",
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        let handled = await client.performMagicTap()
        let error: String? = switch handled {
        case true: nil
        case false: "Magic Tap was not handled by any app responder. Implement accessibilityPerformMagicTap()."
        case nil: "The in-app SDK Magic Tap request failed; check that the target app is still foreground."
        }
        return MagicTapResponse(
            requestId: request.requestId, available: true, handled: handled, error: error,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }
}
