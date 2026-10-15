import XCTest
@testable import XCTestRunner

final class MCPJSONRPCHelpersTests: XCTestCase {
    func testEncodeParamsMatchesDefaultJSONSerializationOutput() throws {
        let params: [String: Any] = ["uri": "file:///x"]
        let encoded = try MCPJSONRPCHelpers.encodeParams(params, failureMessage: "encode failed")
        let expected = try JSONSerialization.data(withJSONObject: params)

        XCTAssertEqual(encoded, expected)
        XCTAssertEqual(String(data: encoded, encoding: .utf8), #"{"uri":"file:\/\/\/x"}"#)
    }

    func testEncodeParamsRoundTripsNestedValues() throws {
        let params: [String: Any] = [
            "object": ["array": [1, 2.5, true, false, NSNull()]],
        ]
        let encoded = try MCPJSONRPCHelpers.encodeParams(params, failureMessage: "encode failed")
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let object = try XCTUnwrap(decoded["object"] as? [String: Any])
        let array = try XCTUnwrap(object["array"] as? [Any])

        XCTAssertEqual(array.count, 5)
        XCTAssertEqual((array[0] as? NSNumber)?.intValue, 1)
        XCTAssertEqual((array[1] as? NSNumber)?.doubleValue, 2.5)
        XCTAssertEqual((array[2] as? NSNumber)?.boolValue, true)
        XCTAssertEqual((array[3] as? NSNumber)?.boolValue, false)
        XCTAssertTrue(array[4] is NSNull)
    }

    func testEncodeParamsUsesPassedFailureMessage() {
        assertError(
            from: { try MCPJSONRPCHelpers.encodeParams(["x": Date()], failureMessage: "first message") },
            equals: .requestFailed("first message"),
            description: "MCP request failed: first message"
        )
        assertError(
            from: { try MCPJSONRPCHelpers.encodeParams(["x": Double.nan], failureMessage: "second message") },
            equals: .requestFailed("second message"),
            description: "MCP request failed: second message"
        )
    }

    func testExtractTextContentReturnsFirstValidTextItem() throws {
        let result: [String: Any] = [
            "content": [
                ["type": "image", "text": "skip"],
                ["type": "text"],
                ["type": "text", "text": "first"],
                ["type": "text", "text": "second"],
            ],
        ]

        XCTAssertEqual(try MCPJSONRPCHelpers.extractTextContent(from: result), "first")
    }

    func testExtractTextContentReportsMissingContentArray() {
        assertError(
            from: { try MCPJSONRPCHelpers.extractTextContent(from: [:]) },
            equals: .invalidResponse("Missing content array"),
            description: "Invalid MCP response: Missing content array"
        )
        assertError(
            from: { try MCPJSONRPCHelpers.extractTextContent(from: ["content": ["not a dictionary"]]) },
            equals: .invalidResponse("Missing content array"),
            description: "Invalid MCP response: Missing content array"
        )
    }

    func testExtractTextContentReportsMissingTextContent() {
        assertError(
            from: { try MCPJSONRPCHelpers.extractTextContent(from: ["content": []]) },
            equals: .invalidResponse("Missing text content"),
            description: "Invalid MCP response: Missing text content"
        )
        assertError(
            from: { try MCPJSONRPCHelpers.extractTextContent(from: ["content": [["type": "text"]]]) },
            equals: .invalidResponse("Missing text content"),
            description: "Invalid MCP response: Missing text content"
        )
    }

    func testExtractResourceTextContentReturnsFirstText() throws {
        let result: [String: Any] = ["contents": [["text": "resource"]]]

        XCTAssertEqual(try MCPJSONRPCHelpers.extractResourceTextContent(from: result), "resource")
    }

    func testExtractResourceTextContentReportsMissingContents() {
        assertError(
            from: { try MCPJSONRPCHelpers.extractResourceTextContent(from: [:]) },
            equals: .invalidResponse("Missing resource contents"),
            description: "Invalid MCP response: Missing resource contents"
        )
        assertError(
            from: { try MCPJSONRPCHelpers.extractResourceTextContent(from: ["contents": []]) },
            equals: .invalidResponse("Missing resource contents"),
            description: "Invalid MCP response: Missing resource contents"
        )
    }

    func testExtractResourceTextContentRequiresTextOnFirstElement() {
        assertError(
            from: {
                try MCPJSONRPCHelpers.extractResourceTextContent(
                    from: ["contents": [["mimeType": "text/plain"], ["text": "later"]]]
                )
            },
            equals: .invalidResponse("Missing resource text content"),
            description: "Invalid MCP response: Missing resource text content"
        )
    }

    private func assertError(
        from operation: () throws -> Any,
        equals expectedError: MCPClientError,
        description expectedDescription: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? MCPClientError, expectedError, file: file, line: line)
            XCTAssertEqual((error as? MCPClientError)?.description, expectedDescription, file: file, line: line)
        }
    }
}
