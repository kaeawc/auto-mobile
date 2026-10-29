import Foundation

/// Launch request for one SDK contract scenario (#5164). The contract harness
/// (`scripts/ios/sdk-contract-integration.sh`) launches Playground with
/// `SIMCTL_CHILD_PLAYGROUND_SDK_CONTRACT=<scenario>` and
/// `SIMCTL_CHILD_PLAYGROUND_SDK_CONTRACT_RUN_ID=<id>`; a normal launch has neither and runs nothing.
struct SdkContractLaunch: Equatable {
    static let scenarioKey = "PLAYGROUND_SDK_CONTRACT"
    static let runIdKey = "PLAYGROUND_SDK_CONTRACT_RUN_ID"
    static let maxRunIdLength = 64

    let scenario: String
    let runId: String

    static func from(environment: [String: String]) -> SdkContractLaunch? {
        guard let scenario = environment[scenarioKey], !scenario.isEmpty,
              let runId = environment[runIdKey], isSafeRunId(runId)
        else {
            return nil
        }
        return SdkContractLaunch(scenario: scenario, runId: runId)
    }

    /// The run id becomes a file name and a URL path segment, so it is limited to ASCII
    /// letters, digits and hyphens.
    static func isSafeRunId(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maxRunIdLength else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || scalar == "-")
        }
    }
}
