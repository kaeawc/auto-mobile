import XCTest
@testable import XCTestRunner

final class MCPEndpointTests: XCTestCase {
    func testAppendsRouteToBareHost() {
        XCTAssertEqual(
            MCPEndpoint.normalize("http://localhost:9000"),
            "http://localhost:9000/auto-mobile/streamable"
        )
    }

    func testTrailingSlashDoesNotDuplicateSegment() {
        // Pre-fix this produced "http://host/auto-mobile//auto-mobile/streamable".
        XCTAssertEqual(
            MCPEndpoint.normalize("http://host/auto-mobile/"),
            "http://host/auto-mobile/streamable"
        )
    }

    func testAutoMobileSuffixGainsStreamableOnly() {
        XCTAssertEqual(
            MCPEndpoint.normalize("http://host/auto-mobile"),
            "http://host/auto-mobile/streamable"
        )
    }

    func testQueryItemsArePreservedAndRouteGoesOnPath() {
        // Pre-fix the route landed inside the query: "http://host/auto-mobile?token=x/auto-mobile/streamable".
        XCTAssertEqual(
            MCPEndpoint.normalize("http://host/auto-mobile?token=x"),
            "http://host/auto-mobile/streamable?token=x"
        )
    }

    func testAlreadyNormalizedEndpointPassesThrough() {
        let endpoint = "http://localhost:9000/auto-mobile/streamable"
        XCTAssertEqual(MCPEndpoint.normalize(endpoint), endpoint)
    }

    func testSseEndpointPassesThrough() {
        let endpoint = "http://localhost:9000/auto-mobile/sse"
        XCTAssertEqual(MCPEndpoint.normalize(endpoint), endpoint)
    }

    func testWhitespaceIsTrimmed() {
        XCTAssertEqual(
            MCPEndpoint.normalize("  http://host  "),
            "http://host/auto-mobile/streamable"
        )
    }
}
