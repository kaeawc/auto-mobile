@testable import CtrlProxy
import XCTest

final class ModelsTests: XCTestCase {
    func testFrameContextGenerationInvalidatesAnABAReturnToTheSameHierarchy() {
        let screenA = ViewHierarchy(
            packageName: "com.example.a",
            hierarchy: UIElementInfo(text: "A")
        )
        let screenB = ViewHierarchy(
            packageName: "com.example.b",
            hierarchy: UIElementInfo(text: "B")
        )

        let frameContext = FrameContext()
        frameContext.recordTransition(to: screenA)
        let firstScreenAContext = frameContext.context(for: screenA)
        frameContext.recordTransition(to: screenB)
        frameContext.recordTransition(to: screenA)
        let returnedScreenAContext = frameContext.context(for: screenA)

        XCTAssertNotEqual(firstScreenAContext, returnedScreenAContext)
    }

    // MARK: - PerfTiming Tests

    func testPerfTimingEncoding() throws {
        let timing = PerfTiming(name: "test", durationMs: 100)

        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(timing)
        let json = String(data: data, encoding: .utf8)

        XCTAssertEqual(json, #"{"durationMs":100,"name":"test"}"#)
    }

    func testPerfTimingWithChildren() throws {
        let child1 = PerfTiming(name: "child1", durationMs: 30)
        let child2 = PerfTiming(name: "child2", durationMs: 20)
        let parent = PerfTiming(name: "parent", durationMs: 100, children: [child1, child2])

        let encoder = JSONEncoder()
        let data = try encoder.encode(parent)
        let decoded = try JSONDecoder().decode(PerfTiming.self, from: data)

        XCTAssertEqual(decoded.name, "parent")
        XCTAssertEqual(decoded.durationMs, 100)
        XCTAssertEqual(decoded.children?.count, 2)
        XCTAssertEqual(decoded.children?[0].name, "child1")
        XCTAssertEqual(decoded.children?[1].name, "child2")
    }

    func testPerfTimingConvenienceMethods() {
        let simple = PerfTiming.timing("simple", durationMs: 50)
        XCTAssertNil(simple.children)

        let withChildren = PerfTiming.timing("parent", durationMs: 100, children: [
            PerfTiming.timing("child", durationMs: 30),
        ])
        XCTAssertNotNil(withChildren.children)
        XCTAssertEqual(withChildren.children?.count, 1)
    }

    // MARK: - ViewHierarchy scale reporting (#4548)

    func testViewHierarchyDecodesLegacyPayloadWithoutScaleMetadata() throws {
        // A hierarchy JSON produced before #4548 carries no nativeScale/pixelWidth/pixelHeight.
        // Decoding must succeed with the additive fields absent, not fail or invent values.
        let legacyJson = """
        {"updatedAt":1,"packageName":"com.test.app","screenScale":3.0,"screenWidth":375,\
        "screenHeight":812,"insets":{"available":false,"source":"unavailable","units":"unknown"}}
        """
        let decoded = try JSONDecoder().decode(ViewHierarchy.self, from: Data(legacyJson.utf8))

        XCTAssertEqual(decoded.screenScale, 3.0)
        XCTAssertNil(decoded.nativeScale)
        XCTAssertNil(decoded.pixelWidth)
        XCTAssertNil(decoded.pixelHeight)
    }

    func testViewHierarchyEncodesScaleMetadataWhenPresentAndOmitsWhenAbsent() throws {
        let withMetadata = ViewHierarchy(
            updatedAt: 1,
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            nativeScale: 3.144,
            pixelWidth: 1179,
            pixelHeight: 2553
        )
        let encodedWith = try XCTUnwrap(
            String(data: JSONEncoder().encode(withMetadata), encoding: .utf8)
        )
        XCTAssertTrue(encodedWith.contains("\"nativeScale\""))
        XCTAssertTrue(encodedWith.contains("\"pixelWidth\":1179"))
        XCTAssertTrue(encodedWith.contains("\"pixelHeight\":2553"))

        // Absent metadata is OMITTED from the wire (additive contract), never emitted as null.
        let withoutMetadata = ViewHierarchy(updatedAt: 1, screenWidth: 375, screenHeight: 812)
        let encodedWithout = try XCTUnwrap(
            String(data: JSONEncoder().encode(withoutMetadata), encoding: .utf8)
        )
        XCTAssertFalse(encodedWithout.contains("nativeScale"))
        XCTAssertFalse(encodedWithout.contains("pixelWidth"))
        XCTAssertFalse(encodedWithout.contains("pixelHeight"))
    }

    func testViewHierarchyRetainsNativeScaleDoublePrecision() throws {
        let hierarchy = ViewHierarchy(
            updatedAt: 1,
            screenWidth: 450,
            screenHeight: 750,
            nativeScale: 2.61,
            pixelWidth: 1175,
            pixelHeight: 1958
        )

        let nativeScale = try XCTUnwrap(hierarchy.nativeScale)
        XCTAssertEqual(Double(nativeScale), 2.61, accuracy: 0)
    }

    // MARK: - WebSocketRequest Tests

    func testWebSocketRequestDecoding() throws {
        let json = """
        {
            "type": "request_tap_coordinates",
            "requestId": "req-123",
            "x": 100,
            "y": 200,
            "duration": 50
        }
        """

        let request = try JSONDecoder().decode(WebSocketRequest.self, from: XCTUnwrap(json.data(using: .utf8)))

        XCTAssertEqual(request.typeString, "request_tap_coordinates")
        guard case let .tapCoordinates(payload) = request else {
            return XCTFail("Expected .tapCoordinates, got \(request)")
        }
        XCTAssertEqual(payload.requestId, "req-123")
        XCTAssertEqual(payload.x, 100)
        XCTAssertEqual(payload.y, 200)
        XCTAssertEqual(payload.duration, 50)
    }

    func testWebSocketRequestSwipeDecoding() throws {
        let json = """
        {
            "type": "request_swipe",
            "x1": 100,
            "y1": 200,
            "x2": 300,
            "y2": 400,
            "duration": 300
        }
        """

        let request = try JSONDecoder().decode(WebSocketRequest.self, from: XCTUnwrap(json.data(using: .utf8)))

        XCTAssertEqual(request.typeString, "request_swipe")
        guard case let .swipe(payload) = request else {
            return XCTFail("Expected .swipe, got \(request)")
        }
        XCTAssertEqual(payload.x1, 100)
        XCTAssertEqual(payload.y1, 200)
        XCTAssertEqual(payload.x2, 300)
        XCTAssertEqual(payload.y2, 400)
        XCTAssertEqual(payload.duration, 300)
    }

    func testWebSocketRequestMultiFingerSwipeDecodesFractionalOffset() throws {
        let json = """
        {
            "type": "request_multi_finger_swipe",
            "x1": 100,
            "y1": 600,
            "x2": 100,
            "y2": 200,
            "duration": 450,
            "offset": 30.5,
            "fingerCount": 3
        }
        """

        let request = try JSONDecoder().decode(WebSocketRequest.self, from: XCTUnwrap(json.data(using: .utf8)))

        XCTAssertEqual(request.typeString, "request_multi_finger_swipe")
        guard case let .multiFingerSwipe(payload) = request else {
            return XCTFail("Expected .multiFingerSwipe, got \(request)")
        }
        XCTAssertEqual(payload.offset ?? -1, 30.5, accuracy: 0.0001)
        XCTAssertEqual(payload.fingerCount, 3)
    }

    func testWebSocketRequestDragDecoding() throws {
        let json = """
        {
            "type": "request_drag",
            "x1": 100,
            "y1": 200,
            "x2": 300,
            "y2": 400,
            "pressDurationMs": 600,
            "dragDurationMs": 300,
            "holdDurationMs": 100
        }
        """

        let request = try JSONDecoder().decode(WebSocketRequest.self, from: XCTUnwrap(json.data(using: .utf8)))

        XCTAssertEqual(request.typeString, "request_drag")
        guard case let .drag(payload) = request else {
            return XCTFail("Expected .drag, got \(request)")
        }
        XCTAssertEqual(payload.pressDurationMs, 600)
        XCTAssertEqual(payload.dragDurationMs, 300)
        XCTAssertEqual(payload.holdDurationMs, 100)
    }

    // MARK: - WebSocketResponse Tests

    func testWebSocketResponseSuccess() {
        let response = WebSocketResponse.success(
            type: "tap_coordinates_result",
            requestId: "req-123",
            totalTimeMs: 50
        )

        XCTAssertEqual(response.type, "tap_coordinates_result")
        XCTAssertEqual(response.requestId, "req-123")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.totalTimeMs, 50)
        XCTAssertNil(response.error)
    }

    func testWebSocketResponseError() {
        let response = WebSocketResponse.error(
            type: "tap_coordinates_result",
            requestId: "req-123",
            error: "Element not found"
        )

        XCTAssertEqual(response.type, "tap_coordinates_result")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.error, "Element not found")
    }

    func testWebSocketResponseWithPerfTiming() throws {
        let perfTiming = PerfTiming(name: "total", durationMs: 100, children: [
            PerfTiming(name: "find", durationMs: 30),
            PerfTiming(name: "tap", durationMs: 70),
        ])

        let response = WebSocketResponse(
            type: "tap_coordinates_result",
            requestId: "req-123",
            success: true,
            totalTimeMs: 100,
            perfTiming: perfTiming
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(response)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: data)

        XCTAssertNotNil(decoded.perfTiming)
        XCTAssertEqual(decoded.perfTiming?.name, "total")
        XCTAssertEqual(decoded.perfTiming?.children?.count, 2)
    }

    // MARK: - HierarchyUpdateResponse Tests

    func testHierarchyUpdateResponseEncoding() throws {
        let hierarchy = ViewHierarchy(
            packageName: "com.example.app",
            hierarchy: UIElementInfo(
                text: "Hello",
                className: "UILabel",
                bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 50)
            )
        )

        let response = HierarchyUpdateResponse(
            requestId: "req-456",
            data: hierarchy
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(response)
        let decoded = try JSONDecoder().decode(HierarchyUpdateResponse.self, from: data)

        XCTAssertEqual(decoded.type, "hierarchy_update")
        XCTAssertEqual(decoded.requestId, "req-456")
        XCTAssertEqual(decoded.data?.packageName, "com.example.app")
        XCTAssertEqual(decoded.data?.hierarchy?.text, "Hello")
    }

    // MARK: - UIElementInfo Tests

    func testUIElementInfoEncoding() throws {
        let element = UIElementInfo(
            text: "Button",
            contentDesc: "Submit button",
            resourceId: "com.example:id/submit",
            className: "UIButton",
            bounds: ElementBounds(left: 10, top: 20, right: 110, bottom: 70),
            clickable: "true",
            enabled: "true"
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(element)
        let jsonObject = try JSONSerialization.jsonObject(with: data)
        let json = try XCTUnwrap(jsonObject as? [String: Any])

        // Check that content-desc uses hyphenated key (Android format)
        XCTAssertNotNil(json["content-desc"])
        XCTAssertEqual(json["content-desc"] as? String, "Submit button")

        // Check that resource-id uses hyphenated key
        XCTAssertNotNil(json["resource-id"])
        XCTAssertEqual(json["resource-id"] as? String, "com.example:id/submit")
    }

    func testUIElementInfoDecoding() throws {
        let json = """
        {
            "text": "Label",
            "content-desc": "Description",
            "resource-id": "com.example:id/label",
            "className": "UILabel",
            "bounds": {"left": 0, "top": 0, "right": 100, "bottom": 50},
            "clickable": "false",
            "enabled": "true"
        }
        """

        let element = try JSONDecoder().decode(UIElementInfo.self, from: XCTUnwrap(json.data(using: .utf8)))

        XCTAssertEqual(element.text, "Label")
        XCTAssertEqual(element.contentDesc, "Description")
        XCTAssertEqual(element.resourceId, "com.example:id/label")
        XCTAssertEqual(element.clickable, "false")
    }

    func testUIElementInfoEncodesCompactSemanticLinkMetadata() throws {
        let info = UIElementInfo(
            text: "Terms of Service",
            semanticLinks: [SemanticLink(text: "Terms of Service", occurrence: 0)],
            role: "link"
        )

        let data = try JSONEncoder().encode(info)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let links = try XCTUnwrap(json["semantic-links"] as? [[String: Any]])

        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links[0]["text"] as? String, "Terms of Service")
        XCTAssertEqual(links[0]["occurrence"] as? Int, 0)
        XCTAssertNil(json["start"])
        XCTAssertNil(json["end"])
    }

    // MARK: - ElementBounds Tests

    func testElementBoundsComputedProperties() {
        let bounds = ElementBounds(left: 10, top: 20, right: 110, bottom: 70)

        XCTAssertEqual(bounds.width, 100)
        XCTAssertEqual(bounds.height, 50)
        XCTAssertEqual(bounds.centerX, 60)
        XCTAssertEqual(bounds.centerY, 45)
    }

    // MARK: - HighlightShape Tests

    func testHighlightShapeBox() throws {
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50),
            style: HighlightStyle(strokeColor: "#FF0000", strokeWidth: 2.0)
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(shape)
        let decoded = try JSONDecoder().decode(HighlightShape.self, from: data)

        XCTAssertEqual(decoded.type, "box")
        XCTAssertEqual(decoded.bounds?.x, 10)
        XCTAssertEqual(decoded.bounds?.width, 100)
        XCTAssertEqual(decoded.style?.strokeColor, "#FF0000")
    }

    func testHighlightShapePath() throws {
        let shape = HighlightShape(
            type: "path",
            points: [
                HighlightPoint(x: 0, y: 0),
                HighlightPoint(x: 100, y: 100),
                HighlightPoint(x: 200, y: 50),
            ]
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(shape)
        let decoded = try JSONDecoder().decode(HighlightShape.self, from: data)

        XCTAssertEqual(decoded.type, "path")
        XCTAssertEqual(decoded.points?.count, 3)
        XCTAssertEqual(decoded.points?[1].x, 100)
        XCTAssertEqual(decoded.points?[1].y, 100)
    }

    // MARK: - RequestType Tests

    func testRequestTypeRawValues() {
        XCTAssertEqual(RequestType.requestHierarchy.rawValue, "request_hierarchy")
        XCTAssertEqual(RequestType.requestTapCoordinates.rawValue, "request_tap_coordinates")
        XCTAssertEqual(RequestType.requestSwipe.rawValue, "request_swipe")
        XCTAssertEqual(RequestType.requestMultiFingerSwipe.rawValue, "request_multi_finger_swipe")
        XCTAssertEqual(RequestType.requestDrag.rawValue, "request_drag")
        XCTAssertEqual(RequestType.requestSetText.rawValue, "request_set_text")
        XCTAssertEqual(RequestType.requestPressBack.rawValue, "request_press_back")
        XCTAssertEqual(RequestType.requestLaunchApp.rawValue, "request_launch_app")
    }

    func testConnectedEventAdvertisesSupportedCommands() {
        let event = ConnectedEvent(id: 7)

        XCTAssertEqual(event.type, "connected")
        XCTAssertEqual(event.id, 7)
        XCTAssertEqual(event.supportedCommands, RequestType.allCases.map(\.rawValue).sorted())
        XCTAssertEqual(event.supportedFeatures, ["display_cutout_info"])
        XCTAssertTrue(event.supportedCommands.contains("request_press_back"))
        XCTAssertTrue(event.supportedCommands.contains("request_keyboard"))
    }

    // MARK: - ResponseType Tests

    func testResponseTypeRawValues() {
        XCTAssertEqual(ResponseType.hierarchyUpdate.rawValue, "hierarchy_update")
        XCTAssertEqual(ResponseType.tapCoordinatesResult.rawValue, "tap_coordinates_result")
        XCTAssertEqual(ResponseType.swipeResult.rawValue, "swipe_result")
        XCTAssertEqual(ResponseType.multiFingerSwipeResult.rawValue, "multi_finger_swipe_result")
        XCTAssertEqual(ResponseType.screenshot.rawValue, "screenshot")
        XCTAssertEqual(ResponseType.pressBackResult.rawValue, "press_back_result")
        XCTAssertEqual(ResponseType.launchAppResult.rawValue, "launch_app_result")
    }

    // MARK: - UIElementInfo value field

    func testUIElementInfoValueFieldEncodesUnderValueKey() throws {
        let info = UIElementInfo(
            text: "Search videos",
            value: "hello iOS",
            hintText: "Search videos"
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(info)
        let json = String(data: data, encoding: .utf8) ?? ""

        XCTAssertTrue(json.contains("\"value\":\"hello iOS\""), "value should be serialized: \(json)")
        XCTAssertTrue(json.contains("\"text\":\"Search videos\""), "text should still be present: \(json)")
        XCTAssertTrue(json.contains("\"hint-text\":\"Search videos\""), "hint-text should be present: \(json)")
    }

    func testUIElementInfoValueFieldOmittedWhenNil() throws {
        let info = UIElementInfo(text: "Just a label")

        let data = try JSONEncoder().encode(info)
        let json = String(data: data, encoding: .utf8) ?? ""

        XCTAssertFalse(json.contains("\"value\""), "value should be omitted when nil: \(json)")
    }

    func testUIElementInfoValueRoundTrips() throws {
        let original = UIElementInfo(
            text: "Email",
            value: "user@example.com",
            password: "false"
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(UIElementInfo.self, from: data)

        XCTAssertEqual(decoded.text, "Email")
        XCTAssertEqual(decoded.value, "user@example.com")
        XCTAssertEqual(decoded.password, "false")
    }
}
