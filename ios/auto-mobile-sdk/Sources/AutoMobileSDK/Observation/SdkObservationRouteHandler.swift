#if DEBUG && !os(watchOS)
    import AutoMobileSdkWire
    import Foundation
    #if canImport(UIKit)
        import UIKit
    #endif

    protocol SdkSceneInventory: Sendable {
        @MainActor
        func connectedSceneIdentifiers() -> [String]
    }

    struct ApplicationSdkSceneInventory: SdkSceneInventory {
        @MainActor
        func connectedSceneIdentifiers() -> [String] {
            #if canImport(UIKit)
                UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.session.persistentIdentifier }
                    .sorted()
            #else
                []
            #endif
        }
    }

    /// Serves the observation-bridge routes (#5159): `POST /observation/snapshot` returns the
    /// registered bridge's observation, and `POST /observation/action` performs one
    /// ``AutoMobileAction`` and returns its ``AutoMobileActionResult``.
    ///
    /// More than one connected window scene answers `409 multi_scene` with scene identifiers before
    /// the bridge is read or an action is decoded.
    /// A missing bridge answers `503 {"error":"bridge_not_registered"}`; an undecodable action
    /// answers `400 {"error":"bad_request"}`. An action kind the host did not declare in
    /// `supportedActions` is rejected with reason `unsupported_action` without reaching the bridge.
    /// The bridge's own stale and actionability results pass through unchanged.
    struct SdkObservationRouteHandler: Sendable {
        static let unsupportedActionReason = "unsupported_action"

        let registry: AutoMobileObservationRegistry
        let sceneInventory: any SdkSceneInventory

        init(
            registry: AutoMobileObservationRegistry,
            sceneInventory: any SdkSceneInventory = ApplicationSdkSceneInventory()
        ) {
            self.registry = registry
            self.sceneInventory = sceneInventory
        }

        private func sceneFailure() async -> SdkRouteResponse? {
            let scenes = await sceneInventory.connectedSceneIdentifiers().sorted()
            guard scenes.count > 1 else { return nil }
            let encoded = Self.encode(SdkMultiSceneError(scenes: scenes))
            return SdkRouteResponse(statusCode: 409, body: encoded.body)
        }

        func observe() async -> SdkRouteResponse {
            if let failure = await sceneFailure() { return failure }
            guard let bridge = registry.bridge else { return Self.notRegistered }
            return Self.encode(await bridge.observe())
        }

        func perform(body: Data?) async -> SdkRouteResponse {
            if let failure = await sceneFailure() { return failure }
            guard let body, let action = try? JSONDecoder().decode(AutoMobileAction.self, from: body) else {
                return SdkRouteResponse(statusCode: 400, body: Data(#"{"error":"bad_request"}"#.utf8))
            }
            guard let registration = registry.registration else { return Self.notRegistered }
            guard registration.supportedActions.contains(action.kind) else {
                return Self.encode(AutoMobileActionResult(status: .rejected, reason: Self.unsupportedActionReason))
            }
            return Self.encode(await registration.bridge.perform(action))
        }

        private static let notRegistered = SdkRouteResponse(
            statusCode: 503, body: Data(#"{"error":"bridge_not_registered"}"#.utf8)
        )

        private static func encode(_ value: some Encodable) -> SdkRouteResponse {
            guard let data = try? JSONEncoder().encode(value) else {
                return SdkRouteResponse(statusCode: 500, body: Data(#"{"error":"encode_failed"}"#.utf8))
            }
            return SdkRouteResponse(statusCode: 200, body: data)
        }
    }
#endif
