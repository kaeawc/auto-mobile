import AutoMobileSdkWire
import Foundation

extension CommandHandler {
    /// Relay a host trigger to the foreground app's SDK `POST /trigger` route (#1580).
    func handleSdkTrigger(_ request: RequestSdkTrigger, startTime: Date) async -> SdkTriggerResponse {
        func response(available: Bool, reply: SdkTriggerReply? = nil, error: String?) -> SdkTriggerResponse {
            SdkTriggerResponse(
                requestId: request.requestId, available: available, reply: reply, error: error,
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }
        guard let module = request.module, !module.isEmpty, let trigger = request.trigger, !trigger.isEmpty else {
            return response(available: false, error: "request_sdk_trigger requires a module and a trigger.")
        }
        var payload: [String: Any] = [:]
        if let payloadJson = request.payloadJson {
            guard let data = payloadJson.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                return response(available: false, error: "request_sdk_trigger payloadJson must be a JSON object.")
            }
            payload = object
        }
        guard let info = await sdkServerInfoForTrackedForegroundApp(),
              info.capabilities.contains("sdk-trigger"),
              let client = sdkHierarchyClient
        else {
            return response(
                available: false,
                error: "The foreground app does not embed the AutoMobile in-app SDK with sdk-trigger support."
            )
        }
        let fields: [String: Any] = ["module": module, "trigger": trigger, "payload": payload]
        guard let body = try? JSONSerialization.data(withJSONObject: fields) else {
            return response(available: true, error: "request_sdk_trigger could not encode the trigger body.")
        }
        guard let reply = await client.sendTrigger(body) else {
            return response(
                available: true,
                error: "The in-app SDK trigger request failed; check that the target app is still foreground."
            )
        }
        let error: String? = reply.statusCode == 200
            ? nil
            : "The in-app SDK rejected trigger \(module).\(trigger): \(reply.error ?? "HTTP \(reply.statusCode)")"
        return response(available: true, reply: reply, error: error)
    }
}

extension CommandHandler {
    func handleSdkObservation(_ request: RequestEnvelope, startTime: Date) async -> SdkObservationResponse {
        let outcome = await bridgeReply(route: .observationSnapshot, body: Data("{}".utf8)).flatMap { data in
            Result { try JSONDecoder().decode(AutoMobileObservationSnapshot.self, from: data) }
                .mapError { _ in SdkBridgeFailure.badReply }
        }
        return SdkObservationResponse(
            requestId: request.requestId, outcome: outcome, totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleSdkAction(_ request: RequestSdkAction, startTime: Date) async -> SdkActionResponse {
        let outcome: Result<AutoMobileActionResult, SdkBridgeFailure>
        if let json = request.actionJson, let body = json.data(using: .utf8),
           (try? JSONDecoder().decode(AutoMobileAction.self, from: body)) != nil
        {
            outcome = await bridgeReply(route: .observationAction, body: body).flatMap { data in
                Result { try JSONDecoder().decode(AutoMobileActionResult.self, from: data) }
                    .mapError { _ in SdkBridgeFailure.badReply }
            }
        } else {
            outcome = .failure(.invalidAction)
        }
        return SdkActionResponse(
            requestId: request.requestId, outcome: outcome, totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// Sends one observation-bridge request to the tracked foreground app's SDK, only when its
    /// `/health` reports a registered bridge, and maps the SDK's status codes to typed failures.
    private func bridgeReply(route: SdkRoute, body: Data) async -> Result<Data, SdkBridgeFailure> {
        guard let info = await sdkServerInfoForTrackedForegroundApp(),
              info.observationBridge?.available == true
        else {
            return .failure(.bridgeUnavailable)
        }
        return await sdkReply(route: route, body: body)
    }

    /// `bridgeUnavailable` means the request was never sent. A request that was sent but got no
    /// reply is `badReply`: the SDK may have acted, so the daemon must not retry it elsewhere.
    private func sdkReply(route: SdkRoute, body: Data) async -> Result<Data, SdkBridgeFailure> {
        guard let client = sdkHierarchyClient else { return .failure(.bridgeUnavailable) }
        guard let reply = await client.sendObservationRequest(route, body: body) else {
            return .failure(.badReply)
        }
        switch reply.statusCode {
        case 200: return .success(reply.body)
        case 403: return .failure(.disallowedOrigin)
        case 404: return .failure(.noSnapshot)
        case 409: return .failure(.appNotActive)
        case 410: return .failure(.webProcessUnavailable)
        case 413: return .failure(.messageTooLarge)
        case 503: return .failure(.bridgeUnavailable)
        default: return .failure(.badReply)
        }
    }
}

extension CommandHandler {
    func handleSdkWebSnapshot(_ request: RequestSdkWebSnapshot, startTime: Date) async -> SdkWebSnapshotResponse {
        let webViews = await registeredWebViews()
        let outcome: Result<AutoMobileWebSnapshotReply, SdkBridgeFailure>
        if let webViews, !webViews.isEmpty,
           let body = try? JSONEncoder().encode(AutoMobileWebSnapshotRequest(webViewId: request.webViewId))
        {
            outcome = await sdkReply(route: .webViewSnapshot, body: body).flatMap { data in
                Result { try JSONDecoder().decode(AutoMobileWebSnapshotReply.self, from: data) }
                    .mapError { _ in SdkBridgeFailure.badReply }
            }
        } else {
            outcome = .failure(.bridgeUnavailable)
        }
        return SdkWebSnapshotResponse(
            requestId: request.requestId, outcome: outcome, webViews: webViews,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleSdkWebAction(_ request: RequestSdkWebAction, startTime: Date) async -> SdkWebActionResponse {
        let outcome: Result<AutoMobileWebActionResult, SdkBridgeFailure>
        if let body = Self.webActionBody(request) {
            let webViews = await registeredWebViews() ?? []
            if webViews.contains(where: { $0.webViewId == request.webViewId }) {
                outcome = await sdkReply(route: .webViewAction, body: body).flatMap { data in
                    Result { try JSONDecoder().decode(AutoMobileWebActionResult.self, from: data) }
                        .mapError { _ in SdkBridgeFailure.badReply }
                }
            } else {
                outcome = .failure(.bridgeUnavailable)
            }
        } else {
            outcome = .failure(.invalidAction)
        }
        return SdkWebActionResponse(
            requestId: request.requestId, outcome: outcome, totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    /// The SDK request body, or nil when `webViewId` is missing or `actionJson` is not one bounded
    /// web action. A JavaScript action has no case in `AutoMobileWebControlAction`, so it is nil.
    private static func webActionBody(_ request: RequestSdkWebAction) -> Data? {
        guard let webViewId = request.webViewId, let json = request.actionJson?.data(using: .utf8),
              let action = try? JSONDecoder().decode(AutoMobileWebControlAction.self, from: json)
        else {
            return nil
        }
        return try? JSONEncoder().encode(AutoMobileWebActionRequest(webViewId: webViewId, action: action))
    }

    /// The tracked foreground app's registered web views, or nil when its SDK did not answer.
    private func registeredWebViews() async -> [WebViewBridgeEntry]? {
        guard let info = await sdkServerInfoForTrackedForegroundApp() else { return nil }
        return info.webViewBridge?.webViews ?? []
    }
}
