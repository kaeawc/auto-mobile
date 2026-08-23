@testable import CtrlProxy
import XCTest

/// Locks the `CommandPayload` protocol + `WebSocketRequest.payload` accessor that
/// collapse the per-command `requestId` accessor into `payload.requestId` (issue
/// #2859 part 3). One exhaustive `switch` extracts the payload as the shared
/// protocol, so `requestId` — and any future common field — reads off it directly.
final class CommandPayloadTests: XCTestCase {
    /// `payload.requestId` is the single source of truth: `WebSocketRequest.requestId`
    /// delegates to it, across distinct-payload, shared-payload, and RequestEnvelope
    /// cases. Each pair proves both the extraction (`payload`) and the delegation
    /// (`requestId`) agree.
    func testRequestIdDelegatesToPayloadAcrossCaseFamilies() {
        let cases: [(request: WebSocketRequest, id: String?)] = [
            (.tapCoordinates(RequestTapCoordinates(requestId: "tap", x: 1, y: 2)), "tap"),
            (.requestHierarchy(RequestHierarchy(requestId: "h")), "h"),
            // Shared payload type across two cases — both must surface their own id.
            (.requestHierarchyIfStale(RequestHierarchy(requestId: "h-stale")), "h-stale"),
            (.twoFingerSwipe(RequestMultiFingerSwipe(requestId: "tfs", x1: 1, y1: 2, x2: 3, y2: 4)), "tfs"),
            (.multiFingerSwipe(RequestMultiFingerSwipe(requestId: "mfs", x1: 1, y1: 2, x2: 3, y2: 4)), "mfs"),
            // RequestEnvelope-backed cases.
            (.pressHome(RequestEnvelope(requestId: "home")), "home"),
            (.selectAll(RequestEnvelope(requestId: "sel")), "sel"),
            (.getVoiceOverState(RequestEnvelope(requestId: "vo")), "vo"),
            (.setVoiceOverState(RequestSetVoiceOverState(requestId: "vo-set", enabled: true)), "vo-set"),
            (.launchApp(RequestLaunchApp(requestId: "launch", bundleId: "com.example.app")), "launch"),
            (.setPreference(RequestSetPreference(requestId: "sp", key: "k", valueType: "STRING")), "sp"),
            (.getTableStructure(RequestGetTableStructure(requestId: "ts")), "ts"),
            // A nil id must round-trip as nil, not an empty string.
            (.tapCoordinates(RequestTapCoordinates(requestId: nil, x: 1, y: 2)), nil),
        ]
        for (request, expected) in cases {
            XCTAssertEqual(request.payload.requestId, expected, "payload.requestId for \(request.typeString)")
            XCTAssertEqual(request.requestId, expected, "requestId for \(request.typeString)")
            XCTAssertEqual(
                request.requestId,
                request.payload.requestId,
                "requestId must delegate to payload for \(request.typeString)"
            )
        }
    }

    /// The `payload` accessor round-trips through the real wire decode path — a
    /// decoded command exposes its id via the protocol, proving conformance holds
    /// for the type the decoder actually produced.
    func testPayloadAccessorWorksOnDecodedRequest() throws {
        let request = try decodeWebSocketRequest(
            #"{"type":"request_set_text","requestId":"decoded-1","text":"hi"}"#
        )
        let payload: CommandPayload = request.payload
        XCTAssertEqual(payload.requestId, "decoded-1")
    }
}
