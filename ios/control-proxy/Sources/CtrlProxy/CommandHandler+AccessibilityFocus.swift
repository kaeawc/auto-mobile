import Foundation

extension CommandHandler {
    func handleAccessibilityFocus(
        _ request: RequestAccessibilityFocus,
        startTime: Date
    )
        async -> AccessibilityFocusResponse
    {
        func response(_ code: AccessibilityFocusErrorCode? = nil, error: String? = nil) -> AccessibilityFocusResponse {
            AccessibilityFocusResponse(
                requestId: request.requestId, success: code == nil, errorCode: code,
                error: error, totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let info = await sdkServerInfoForTrackedForegroundApp(),
              info.capabilities.contains("accessibility-focus"),
              let client = sdkHierarchyClient
        else {
            return response(
                .sdkUnavailable,
                error: "Accessibility focus requires the AutoMobile in-app SDK with accessibility-focus support in the foreground app."
            )
        }
        guard let reply = await client.performAccessibilityFocus(request) else {
            return response(
                .sdkUnavailable,
                error: "The in-app SDK accessibility focus request failed; focus may have been posted. Check that the target app is still foreground."
            )
        }
        if reply.status == "ok", reply.errorCode == nil { return response() }
        let code = reply.errorCode ?? .unsupported
        let error = switch code {
        case .voiceOverOff: "VoiceOver is off. Enable it with accessibility {voiceover:true} before setting focus."
        case .elementNotFound: "No accessibility element matched the selector in the foreground app."
        case .invalidSelector: "Provide a resourceId, text, or contentDesc selector."
        case .sdkUnavailable: "The in-app SDK accessibility focus route is unavailable."
        case .unsupported: "The in-app SDK could not set VoiceOver focus."
        }
        return response(code, error: error)
    }
}
