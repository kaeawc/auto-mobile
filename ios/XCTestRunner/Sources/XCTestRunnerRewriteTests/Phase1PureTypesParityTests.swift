import Foundation
import XCTest

// Differential parity for the Phase-1 pure value types & parsers: every observable behavior of a
// ported type must match the reference oracle exactly. `@testable` reaches the internal
// `AutoMobileEnvironment`/`AutoMobileDaemonSocket`; all other types are public. Same-named types in
// both modules are always module-qualified.
@testable import XCTestRunner
@testable import XCTestRunnerRewrite

final class Phase1PureTypesParityTests: XCTestCase {
    func testMCPClientErrorDescriptionAndRetryabilityParity() {
        let pairs: [(XCTestRunner.MCPClientError, XCTestRunnerRewrite.MCPClientError)] = [
            (.invalidEndpoint("ep"), .invalidEndpoint("ep")),
            (.invalidResponse("resp"), .invalidResponse("resp")),
            (.serverError("srv"), .serverError("srv")),
            (.requestFailed("req"), .requestFailed("req")),
            (.sessionExpired, .sessionExpired),
        ]
        for (reference, rewrite) in pairs {
            XCTAssertEqual(reference.description, rewrite.description)
            XCTAssertEqual(reference.isRetryable, rewrite.isRetryable)
        }
    }

    func testPlanLoaderErrorDescriptionParity() {
        let pairs: [(XCTestRunner.PlanLoaderError, XCTestRunnerRewrite.PlanLoaderError)] = [
            (.notFound("/p"), .notFound("/p")),
            (.unreadable("/p"), .unreadable("/p")),
        ]
        for (reference, rewrite) in pairs {
            XCTAssertEqual(reference.description, rewrite.description)
        }
    }

    func testRecoveryModelProviderParity() {
        let pairs: [(XCTestRunner.RecoveryModelProvider, XCTestRunnerRewrite.RecoveryModelProvider)] = [
            (.anthropic, .anthropic),
            (.openai, .openai),
            (.google, .google),
        ]
        for (reference, rewrite) in pairs {
            XCTAssertEqual(reference.rawValue, rewrite.rawValue)
            XCTAssertEqual(reference.apiKeyEnvVar, rewrite.apiKeyEnvVar)
            XCTAssertEqual(reference.defaultModelName, rewrite.defaultModelName)
        }
    }

    func testRecoveryModelConfigResolveParity() {
        let environments: [[String: String]] = [
            [:],                                                                   // no key → nil
            ["ANTHROPIC_API_KEY": "k"],                                            // default provider
            ["AUTOMOBILE_AI_PROVIDER": "openai", "OPENAI_API_KEY": "k"],           // explicit provider
            ["AUTOMOBILE_AI_PROVIDER": "google", "GEMINI_API_KEY": "k",
             "AUTOMOBILE_AI_MODEL": "custom-model"],                               // model override
            ["AUTOMOBILE_AI_PROVIDER": "bogus", "ANTHROPIC_API_KEY": "k"],         // unknown → anthropic
            ["AUTOMOBILE_AI_PROVIDER": "openai"],                                  // provider, no key → nil
            ["AUTOMOBILE_AI_PROVIDER": " OpenAI ", "OPENAI_API_KEY": "  k  ",
             "AUTOMOBILE_AI_MODEL": "  "],                                         // trimming + blank override
        ]
        for environment in environments {
            let reference = XCTestRunner.RecoveryModelConfig.resolve(environment: environment)
            let rewrite = XCTestRunnerRewrite.RecoveryModelConfig.resolve(environment: environment)
            XCTAssertEqual(reference?.provider.rawValue, rewrite?.provider.rawValue, "env=\(environment)")
            XCTAssertEqual(reference?.modelName, rewrite?.modelName, "env=\(environment)")
        }
    }

    func testAutoMobileEnvironmentParity() {
        let values = ["EMPTY": "", "NUM": "42", "FLAG": "true", "DBL": "1.5", "NOTNUM": "x"]
        let reference = XCTestRunner.AutoMobileEnvironment(values: values)
        let rewrite = XCTestRunnerRewrite.AutoMobileEnvironment(values: values)
        XCTAssertEqual(reference.firstNonEmpty(["EMPTY", "NUM"]), rewrite.firstNonEmpty(["EMPTY", "NUM"]))
        XCTAssertEqual(reference.firstNonEmpty(["MISSING"]), rewrite.firstNonEmpty(["MISSING"]))
        XCTAssertEqual(reference.intValue(["NUM"]), rewrite.intValue(["NUM"]))
        XCTAssertEqual(reference.intValue(["NOTNUM"]), rewrite.intValue(["NOTNUM"]))
        XCTAssertEqual(reference.doubleValue(["DBL"]), rewrite.doubleValue(["DBL"]))
        XCTAssertEqual(reference.boolValue(["FLAG"]), rewrite.boolValue(["FLAG"]))
        XCTAssertEqual(reference.boolValue(["EMPTY"]), rewrite.boolValue(["EMPTY"]))
        XCTAssertEqual(reference.boolValue(["NOTNUM"]), rewrite.boolValue(["NOTNUM"]))
    }

    func testDaemonSocketDefaultPathParity() {
        XCTAssertEqual(XCTestRunner.AutoMobileDaemonSocket.defaultPath,
                       XCTestRunnerRewrite.AutoMobileDaemonSocket.defaultPath)
    }

    func testPlanStepToolParserParity() {
        let plans = [
            """
            platform: ios
            steps:
              - tool: launchApp
                appId: com.apple.reminders
              - observe
              - tool: "tapOn"
                selector:
                  text: Add
              - tool: 'terminateApp'
            """,
            """
            steps:
              - action: something
                tool: inputText
            other:
              - tool: notThis
            """,
            "no steps here at all",
        ]
        for plan in plans {
            XCTAssertEqual(
                XCTestRunner.PlanStepToolParser.toolNames(from: plan),
                XCTestRunnerRewrite.PlanStepToolParser.toolNames(from: plan),
                "plan=\(plan)"
            )
        }
    }

    func testFailureObservationSummaryDecodeParity() throws {
        let json = """
        {"capturedAtMs":123.5,"observeError":"boom","awaitTimeout":true,
         "visibleTextsSample":["a","b"],"resourceIdsSample":["id1"],
         "viewHierarchy":{"ignored":true},"activeWindow":"ignored"}
        """
        let data = Data(json.utf8)
        let reference = try JSONDecoder().decode(XCTestRunner.FailureObservationSummary.self, from: data)
        let rewrite = try JSONDecoder().decode(XCTestRunnerRewrite.FailureObservationSummary.self, from: data)
        XCTAssertEqual(reference.capturedAtMs, rewrite.capturedAtMs)
        XCTAssertEqual(reference.observeError, rewrite.observeError)
        XCTAssertEqual(reference.awaitTimeout, rewrite.awaitTimeout)
        XCTAssertEqual(reference.visibleTextsSample, rewrite.visibleTextsSample)
        XCTAssertEqual(reference.resourceIdsSample, rewrite.resourceIdsSample)
    }
}
