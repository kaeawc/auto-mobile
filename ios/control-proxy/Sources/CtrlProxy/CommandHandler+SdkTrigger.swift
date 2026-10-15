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
