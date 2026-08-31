import Foundation
@testable import XCTestRunnerRewrite

// Shared test doubles for the rewrite test target. Conform to the rewrite's Sendable seams; the
// recording state is single-threaded in these tests, so `@unchecked Sendable` is acceptable.

struct SilentLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

struct StubPlanLoader: AutoMobilePlanLoading {
    let content: String
    func loadPlan(at _: String, bundle _: Bundle?) throws -> String { content }
}

struct NoopDaemonEnsurer: AutoMobileDaemonEnsuring {
    func ensureDaemonRunning(repoRoot _: String?) -> Bool { true }
}

/// Records every MCP call and returns canned responses. `queueExecutePlan` scripts executePlan
/// results; otherwise sensible defaults are returned per method.
final class RecordingMCPClient: AutoMobileMCPClient, @unchecked Sendable {
    struct Call {
        let name: String
        let arguments: [String: Any]
    }

    private(set) var calls: [Call] = []
    private(set) var initializeCallCount = 0
    private(set) var readResourceCallCount = 0
    private(set) var readResourceUris: [String] = []
    var flagResourceText = "{\"key\":\"ai-recovery\",\"enabled\":true,\"config\":{\"maxToolCalls\":5}}"
    var observeText = "{\"elements\":{}}"
    var toolResponseText = "{\"ok\":true}"
    private var executePlanResponses: [String] = []

    var executePlanCalls: [Call] { calls.filter { $0.name == "executePlan" } }
    func call(named name: String) -> Call? { calls.first { $0.name == name } }

    func queueExecutePlan(_ text: String) {
        executePlanResponses.append(text)
    }

    func initialize(timeout _: TimeInterval) throws {
        initializeCallCount += 1
    }

    func callTool(name: String, arguments: [String: Any], timeout _: TimeInterval) throws -> MCPToolResponse {
        calls.append(Call(name: name, arguments: arguments))
        switch name {
        case "setToolEnabled":
            return MCPToolResponse(text: "{\"enabled\":true}")
        case "executePlan":
            guard !executePlanResponses.isEmpty else {
                return MCPToolResponse(text: "{\"success\":true,\"executedSteps\":0,\"totalSteps\":0}")
            }
            return MCPToolResponse(text: executePlanResponses.removeFirst())
        case "observe":
            return MCPToolResponse(text: observeText)
        default:
            return MCPToolResponse(text: toolResponseText)
        }
    }

    func readResource(uri: String, timeout _: TimeInterval) throws -> MCPResourceResponse {
        readResourceCallCount += 1
        readResourceUris.append(uri)
        return MCPResourceResponse(text: flagResourceText)
    }

    func resetSession() {}
}
