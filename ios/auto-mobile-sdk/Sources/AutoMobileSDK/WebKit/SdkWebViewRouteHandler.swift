#if DEBUG && !os(watchOS)
    import AutoMobileSdkWire
    import Foundation

    /// Serves the WKWebView routes (#5162).
    ///
    /// - `POST /webview/snapshot` returns the named (or first) web view's latest snapshot. The
    ///   bridge's policy bounded and redacted it when the page posted it, so nothing unredacted
    ///   leaves here.
    /// - `POST /webview/action` performs one ``AutoMobileWebControlAction`` and returns its
    ///   ``AutoMobileWebActionResult``. The wire type has no JavaScript case, so a request for
    ///   arbitrary script fails to decode and answers `400 bad_request`.
    ///
    /// Errors: `503 bridge_not_registered` (no such web view), `403 disallowed_origin`,
    /// `410 web_process_unavailable`, `404 no_snapshot` (the page has not posted one yet) and
    /// `413 message_too_large` (a request or snapshot over the bridge's message limit). An action's
    /// stale snapshot, unactionable element, disallowed origin or dead content process is a
    /// rejected result instead, because the request itself was well formed.
    struct SdkWebViewRouteHandler: Sendable {
        let registry: AutoMobileWebViewRegistry

        func snapshot(body: Data?) -> SdkRouteResponse {
            var webViewId: String?
            if let body, !body.isEmpty {
                guard let request = try? JSONDecoder().decode(AutoMobileWebSnapshotRequest.self, from: body) else {
                    return Self.error(400, "bad_request")
                }
                webViewId = request.webViewId
            }
            guard let controller = registry.controller(for: webViewId) else {
                return Self.error(503, "bridge_not_registered")
            }
            guard controller.contentProcessAvailable else { return Self.error(410, "web_process_unavailable") }
            guard controller.originAllowed else { return Self.error(403, "disallowed_origin") }
            guard let snapshot = controller.latestSnapshot else { return Self.error(404, "no_snapshot") }
            let reply = AutoMobileWebSnapshotReply(webViewId: controller.webViewId, snapshot: snapshot)
            guard let data = try? JSONEncoder().encode(reply) else { return Self.error(500, "encode_failed") }
            guard data.count <= controller.maxMessageBytes else { return Self.error(413, "message_too_large") }
            return SdkRouteResponse(statusCode: 200, body: data)
        }

        func perform(body: Data?) async -> SdkRouteResponse {
            guard let body, let request = try? JSONDecoder().decode(AutoMobileWebActionRequest.self, from: body)
            else {
                return Self.error(400, "bad_request")
            }
            guard let controller = registry.controller(for: request.webViewId) else {
                return Self.error(503, "bridge_not_registered")
            }
            guard body.count <= controller.maxMessageBytes else { return Self.error(413, "message_too_large") }
            let result = await controller.perform(request.action)
            guard let data = try? JSONEncoder().encode(result) else { return Self.error(500, "encode_failed") }
            return SdkRouteResponse(statusCode: 200, body: data)
        }

        private static func error(_ status: Int, _ code: String) -> SdkRouteResponse {
            SdkRouteResponse(statusCode: status, body: Data(#"{"error":"\#(code)"}"#.utf8))
        }
    }
#endif
