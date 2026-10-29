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
    /// `bridgeUnavailable` means the request was never sent. A request that was sent but got no
    /// reply is `badReply`: the SDK may have acted, so the daemon must not retry it elsewhere.
    private func bridgeReply(route: SdkRoute, body: Data) async -> Result<Data, SdkBridgeFailure> {
        guard let info = await sdkServerInfoForTrackedForegroundApp(),
              info.observationBridge?.available == true,
              let client = sdkHierarchyClient
        else {
            return .failure(.bridgeUnavailable)
        }
        guard let reply = await client.sendObservationRequest(route, body: body) else {
            return .failure(.badReply)
        }
        switch reply.statusCode {
        case 200: return .success(reply.body)
        case 409: return .failure(.appNotActive)
        case 503: return .failure(.bridgeUnavailable)
        default: return .failure(.badReply)
        }
    }
}
