import AXBridgeCore
import Foundation
import XCTest

final class AXBridgeCoreTests: XCTestCase {
    private let rawAction = "Name:Edit mode\nTarget:0x0\nSelector:(null)"

    func testInvokeActionRequestRoundTrip() throws {
        for id: AXBridgeRequestID in [.string("request-1"), .integer(42)] {
            let request = AXBridgeRequest(id: id, actionName: "Edit mode", elementId: "item", elementDesc: "Item label")
            let line = try String(decoding: JSONEncoder().encode(request), as: UTF8.self)
            XCTAssertEqual(try AXBridgeProtocol.decode(line).get(), request)
        }
    }

    func testMalformedJSONReturnsTypedError() {
        guard case let .failure(failure) = AXBridgeProtocol.decode("{broken") else {
            return XCTFail("Expected a typed decode error")
        }
        XCTAssertEqual(failure.error.code, "malformed_request")
        XCTAssertNil(failure.id)
    }

    func testUnknownCommandReturnsTypedErrorAndPreservesID() {
        guard case let .failure(failure) = AXBridgeProtocol.decode(#"{"id":"unknown","command":"tap"}"#) else {
            return XCTFail("Expected a typed command error")
        }
        XCTAssertEqual(failure.error.code, "unknown_command")
        XCTAssertEqual(failure.id, .string("unknown"))
    }

    func testMissingFieldsAndInvalidFieldTypesReturnTypedErrors() {
        for line in [
            #"{"id":1,"command":"invoke-action"}"#,
            #"{"id":1,"command":"invoke-action","actionName":17,"elementId":"item"}"#,
            #"[]"#,
            #"null"#,
            "",
        ] {
            guard case let .failure(failure) = AXBridgeProtocol.decode(line) else {
                XCTFail("Expected a typed error for \(line)")
                continue
            }
            XCTAssertEqual(failure.error.code, "malformed_request")
        }
    }

    func testEmptyActionOrElementSelectorIsRejected() {
        for (action, identifier, description) in [("", "item", ""), ("Edit mode", "", "")] {
            let request = AXBridgeRequest(
                id: .integer(1), actionName: action, elementId: identifier, elementDesc: description
            )
            let response = AXBridgeProtocol.response(for: encoded(request)) { _ in
                XCTFail("Invalid request must not reach the executor")
                return .success(())
            }
            XCTAssertEqual(response.error?.code, "invalid_request")
        }
    }

    func testNameParserExtractsOnlyNameLineAndPreservesRawValue() {
        XCTAssertEqual(AXBridgeActionMatcher.actionName(from: rawAction), "Edit mode")
        XCTAssertEqual(rawAction, "Name:Edit mode\nTarget:0x0\nSelector:(null)")
        XCTAssertNil(AXBridgeActionMatcher.actionName(from: "Target:Edit mode\nSelector:(null)"))
        XCTAssertNil(AXBridgeActionMatcher.actionName(from: "AXPress"))
        XCTAssertNil(AXBridgeActionMatcher.actionName(from: "OtherName:Edit mode"))
        XCTAssertEqual(AXBridgeActionMatcher.actionName(from: "Target:x\nName: Edit mode \nSelector:y"), " Edit mode ")
    }

    func testMatcherReturnsExactRawActionAndItsElement() throws {
        let candidates = [
            AXBridgeCandidate(identifier: "other", description: nil, rawActions: [rawAction]),
            AXBridgeCandidate(identifier: "item", description: "Item label", rawActions: ["AXPress", rawAction]),
        ]
        let request = AXBridgeRequest(id: .integer(1), actionName: "Edit mode", elementId: "item")
        let match = try AXBridgeActionMatcher.match(in: candidates, for: request)
        XCTAssertEqual(match.candidateIndex, 1)
        XCTAssertEqual(Array(match.rawAction.utf8), Array(rawAction.utf8))
    }

    func testMatcherUsesDescriptionAndEitherSuppliedSelector() throws {
        let candidates = [AXBridgeCandidate(identifier: "item", description: "Item label", rawActions: [rawAction])]
        for request in [
            AXBridgeRequest(id: .integer(1), actionName: "Edit mode", elementDesc: "Item label"),
            AXBridgeRequest(id: .integer(1), actionName: "Edit mode", elementId: "Item label"),
            AXBridgeRequest(id: .integer(1), actionName: "Edit mode", elementDesc: "item"),
        ] {
            XCTAssertEqual(try AXBridgeActionMatcher.match(in: candidates, for: request).rawAction, rawAction)
        }
    }

    func testMatcherRejectsPartialNamesPlainActionsAndMetadataMatches() {
        let candidates = [AXBridgeCandidate(
            identifier: "item", description: nil,
            rawActions: [rawAction, "AXPress", "Name:Other\nTarget:Edit\nSelector:(null)"]
        )]
        for name in ["Edit", "mode", "edit mode", "Edit mode ", "AXPress", "Other\nTarget:Edit"] {
            let request = AXBridgeRequest(id: .integer(1), actionName: name, elementId: "item")
            XCTAssertThrowsError(try AXBridgeActionMatcher.match(in: candidates, for: request)) { error in
                XCTAssertEqual((error as? AXBridgeError)?.code, "action_not_found")
            }
        }
    }

    func testMatcherRejectsWrongOrEmptyElementSelector() {
        let candidates = [AXBridgeCandidate(identifier: "", description: "Item label", rawActions: [rawAction])]
        for selector in ["other", "", "Item"] {
            let request = AXBridgeRequest(id: .integer(1), actionName: "Edit mode", elementId: selector)
            XCTAssertThrowsError(try AXBridgeActionMatcher.match(in: candidates, for: request)) { error in
                XCTAssertEqual((error as? AXBridgeError)?.code, "element_not_found")
            }
        }
    }

    func testResponseEncoderProducesOneLineAndEscapesEmbeddedNewlines() throws {
        for response in [
            AXBridgeResponse(id: .string("request\nid")),
            AXBridgeResponse(id: .integer(1), error: AXBridgeError(code: "test", message: rawAction)),
            AXBridgeResponse(id: nil, error: AXBridgeError(code: "test", message: "Malformed")),
        ] {
            let line = try response.encodedLine()
            XCTAssertTrue(line.hasSuffix("\n"))
            XCTAssertEqual(line.filter { $0 == "\n" }.count, 1)
            XCTAssertEqual(try JSONDecoder().decode(AXBridgeResponse.self, from: Data(line.utf8)), response)
        }
        let success = try AXBridgeResponse(id: .integer(1)).encodedLine()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(success.utf8)) as? [String: Any])
        XCTAssertEqual(object.count, 2)
        XCTAssertEqual(object["ok"] as? Bool, true)
    }

    func testDispatchContinuesAfterMalformedRequestAndPreservesExecutorFailure() {
        var executed: [AXBridgeRequest] = []
        let request = AXBridgeRequest(id: .integer(1), actionName: "Edit mode", elementId: "item")
        let responses = ["{", encoded(request), encoded(request)].map { line in
            AXBridgeProtocol.response(for: line) { request in
                executed.append(request)
                return executed.count == 1 ? .failure(.accessibilityNotTrusted) : .success(())
            }
        }
        XCTAssertEqual(executed, [request, request])
        XCTAssertEqual(responses[0].error?.code, "malformed_request")
        XCTAssertEqual(responses[1].error, .accessibilityNotTrusted)
        XCTAssertEqual(responses[2], AXBridgeResponse(id: request.id))
    }

    func testTrustPreflightIsActionable() throws {
        XCTAssertNil(AXBridgeError.preflight(isTrusted: true))
        let error = try XCTUnwrap(AXBridgeError.preflight(isTrusted: false))
        XCTAssertEqual(error.code, "accessibility_not_trusted")
        XCTAssertTrue(error.message.contains("System Settings"))
        XCTAssertTrue(error.message.contains("Privacy & Security > Accessibility"))
    }

    func testEachAXErrorHasDistinctCodeIncludingFutureErrors() {
        XCTAssertNil(AXBridgeError.axFailure(status: 0, operation: "test"))
        let codes = (-25214 ... -25200)
            .compactMap { AXBridgeError.axFailure(status: Int32($0), operation: "test")?.code }
        XCTAssertEqual(codes.count, 15)
        XCTAssertEqual(Set(codes).count, 15)
        XCTAssertEqual(AXBridgeError.axFailure(status: -25204, operation: "test")?.code, "ax_cannot_complete")
        XCTAssertEqual(AXBridgeError.axFailure(status: -1, operation: "test")?.code, "ax_error_-1")
    }

    private func encoded(_ request: AXBridgeRequest) -> String {
        do {
            return try String(decoding: JSONEncoder().encode(request), as: UTF8.self)
        } catch {
            XCTFail("Could not encode request: \(error)")
            return ""
        }
    }
}
