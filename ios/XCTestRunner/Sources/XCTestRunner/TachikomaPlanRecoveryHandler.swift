import Foundation
import Tachikoma

// Tachikoma-backed implementation of `PlanRecoveryHandler` — the iOS counterpart to the Android JUnit
// runner's `AutoMobileAgent.attemptAiRecovery` (which uses Koog). Tachikoma v1.0.0 exposes a low-level
// `ModelInterface.getResponse` primitive rather than a packaged agent loop, so the multi-step
// tool-calling loop is implemented here: prompt the model with the failure context + the AutoMobile
// tool set, execute each requested tool over the shared `AutoMobileMCPClient`, feed results back, and
// repeat up to the `maxToolCalls` budget. After the agent finishes we observe the device ourselves
// (outside the budget) to verify it is in a queryable state — the same success signal Android uses.

// MARK: - Model seam (for testability)

/// Narrow seam over the Tachikoma model call so the recovery loop can be unit-tested with a fake model
/// (no network, no API key). The production implementation is `TachikomaModelResponder`.
public protocol ModelResponding {
    func respond(_ request: ModelRequest) async throws -> ModelResponse
}

/// Resolves a Tachikoma model by name (Anthropic/OpenAI/Google — keys read from the environment by
/// Tachikoma itself) and forwards the request to it.
public struct TachikomaModelResponder: ModelResponding {
    private let modelName: String

    public init(modelName: String) {
        self.modelName = modelName
    }

    public func respond(_ request: ModelRequest) async throws -> ModelResponse {
        let model = try await ModelProvider.shared.getModel(modelName: modelName)
        return try await model.getResponse(request: request)
    }
}

// MARK: - Handler

public final class TachikomaPlanRecoveryHandler: PlanRecoveryHandler {
    private let mcpClient: AutoMobileMCPClient
    private let configProvider: RecoveryConfigProviding
    private let modelConfig: RecoveryModelConfig?
    private let timeoutSeconds: TimeInterval
    private let timer: AutoMobileTimer
    private let logger: AutoMobileLogger
    private let responderFactory: (RecoveryModelConfig) -> ModelResponding
    private let asyncBridge: AsyncCallBridging

    public convenience init(
        mcpClient: AutoMobileMCPClient,
        configProvider: RecoveryConfigProviding,
        modelConfig: RecoveryModelConfig? = RecoveryModelConfig.resolve(),
        timeoutSeconds: TimeInterval = 120,
        timer: AutoMobileTimer = SystemTimer(),
        logger: AutoMobileLogger = StdoutLogger(),
        responderFactory: @escaping (RecoveryModelConfig) -> ModelResponding = { config in
            TachikomaModelResponder(modelName: config.modelName)
        }
    ) {
        self.init(
            mcpClient: mcpClient,
            configProvider: configProvider,
            modelConfig: modelConfig,
            timeoutSeconds: timeoutSeconds,
            timer: timer,
            logger: logger,
            responderFactory: responderFactory,
            asyncBridge: SemaphoreAsyncCallBridge()
        )
    }

    /// Designated initializer. Internal so tests can inject a fake `AsyncCallBridging` (the seam is
    /// not part of the public API surface).
    init(
        mcpClient: AutoMobileMCPClient,
        configProvider: RecoveryConfigProviding,
        modelConfig: RecoveryModelConfig?,
        timeoutSeconds: TimeInterval,
        timer: AutoMobileTimer,
        logger: AutoMobileLogger,
        responderFactory: @escaping (RecoveryModelConfig) -> ModelResponding,
        asyncBridge: AsyncCallBridging
    ) {
        self.mcpClient = mcpClient
        self.configProvider = configProvider
        self.modelConfig = modelConfig
        self.timeoutSeconds = timeoutSeconds
        self.timer = timer
        self.logger = logger
        self.responderFactory = responderFactory
        self.asyncBridge = asyncBridge
    }

    public func attemptRecovery(_ context: FailedStepContext) -> RecoveryOutcome {
        let start = timer.now()

        guard let modelConfig = modelConfig else {
            // No API key for the configured provider — recovery is unavailable. Return failure so the
            // executor falls back to throwing the original plan failure, exactly as before this feature.
            logger.warn("AI recovery unavailable: no API key for the configured provider; skipping.")
            return RecoveryOutcome(success: false, recoveryTimeMs: elapsedMs(since: start))
        }

        let maxToolCalls = configProvider.maxRecoveryToolCalls()
        let responder = responderFactory(modelConfig)
        logger.info(
            "Starting AI recovery for step \(context.failedStepIndex + 1) (\(context.failedTool)) "
                + "with model \(modelConfig.modelName), budget \(maxToolCalls) tool calls..."
        )

        do {
            try runAgentLoop(context: context, responder: responder, settings: modelSettings(for: modelConfig), maxToolCalls: maxToolCalls)
        } catch {
            logger.warn("AI recovery execution failed: \(error)")
            return RecoveryOutcome(success: false, recoveryTimeMs: elapsedMs(since: start))
        }

        // Verify the device is in a queryable state after recovery (outside the tool budget). Mirrors
        // Android: success == a post-recovery observe returned something. The resumed step is the real
        // check of whether recovery actually worked.
        logger.info("AI recovery agent finished, verifying device state...")
        let observeResult = observeDeviceState(context: context)
        return RecoveryOutcome(
            success: observeResult != nil,
            recoveryTimeMs: elapsedMs(since: start),
            observeResultAfterRecovery: observeResult
        )
    }

    // MARK: - Agent loop

    private func runAgentLoop(
        context: FailedStepContext,
        responder: ModelResponding,
        settings: ModelSettings,
        maxToolCalls: Int
    ) throws {
        let tools = Self.buildToolDefinitions()
        var messages: [Message] = [
            .user(content: .text(Self.buildRecoveryPrompt(context: context, maxToolCalls: maxToolCalls))),
        ]

        var toolCallsUsed = 0
        while true {
            let request = ModelRequest(
                messages: messages,
                tools: tools,
                settings: settings,
                systemInstructions: Self.systemInstructions
            )

            let response = try asyncBridge.run(timeout: timeoutSeconds) { try await responder.respond(request) }
            messages.append(.assistant(content: response.content))

            let toolCalls = response.content.compactMap { content -> ToolCallItem? in
                if case let .toolCall(item) = content {
                    return item
                }
                return nil
            }

            if toolCalls.isEmpty {
                // The model produced a final answer with no further actions — recovery attempt done.
                return
            }
            if toolCallsUsed >= maxToolCalls {
                // Budget spent and the model still wants to act. Stop here; the resumed step is the
                // real verification of whether the device recovered.
                return
            }

            for call in toolCalls {
                guard toolCallsUsed < maxToolCalls else {
                    // Budget exhausted mid-batch: acknowledge the remaining calls so the transcript
                    // stays well-formed, but do not touch the device.
                    messages.append(.tool(toolCallId: call.id, content: "{\"error\":\"tool-call budget exhausted\"}"))
                    continue
                }
                toolCallsUsed += 1
                let resultText = executeTool(name: call.function.name, argumentsJSON: call.function.arguments, context: context)
                messages.append(.tool(toolCallId: call.id, content: resultText))
            }
        }
    }

    private func modelSettings(for config: RecoveryModelConfig) -> ModelSettings {
        ModelSettings(modelName: config.modelName, maxTokens: 4096, toolChoice: .auto)
    }

    // MARK: - Tool execution over the AutoMobile MCP client

    private func executeTool(name: String, argumentsJSON: String, context: FailedStepContext) -> String {
        var arguments = Self.parseArguments(argumentsJSON)
        // Required routing fields are injected by us, not trusted from the model, so every recovery
        // call is valid and targets the same platform/session/device as the plan.
        arguments["platform"] = context.platform
        if let session = context.sessionUuid {
            arguments["sessionUuid"] = session
        }
        if let device = context.deviceId {
            arguments["device"] = device
        }
        if name == "tapOn", arguments["action"] == nil {
            arguments["action"] = "tap"
        }

        do {
            let response = try mcpClient.callTool(name: name, arguments: arguments, timeout: timeoutSeconds)
            return response.text
        } catch {
            logger.warn("Recovery tool \(name) failed: \(error)")
            return "{\"error\":\"\(Self.escapeForJSON(String(describing: error)))\"}"
        }
    }

    private func observeDeviceState(context: FailedStepContext) -> String? {
        var arguments: [String: Any] = ["platform": context.platform]
        if let session = context.sessionUuid {
            arguments["sessionUuid"] = session
        }
        if let device = context.deviceId {
            arguments["device"] = device
        }
        do {
            let response = try mcpClient.callTool(name: "observe", arguments: arguments, timeout: timeoutSeconds)
            return response.text
        } catch {
            logger.warn("Post-recovery observe failed: \(error)")
            return nil
        }
    }

    // MARK: - Prompt

    static let systemInstructions = """
    You are an iOS UI test recovery agent. A recorded test plan hit a failing step. Your job is to use \
    the provided AutoMobile tools to get the app back into the state the plan expects so it can resume \
    from the next step. Start by calling observe to see the current screen. Then take the minimal \
    corrective actions needed (dismiss dialogs, navigate to the right screen, wait for elements, retry \
    with a better selector). Do not try to complete the whole test — only fix the immediate blocker so \
    the next step can run. When the device is ready, stop and briefly say what you did.
    """

    static func buildRecoveryPrompt(context: FailedStepContext, maxToolCalls: Int) -> String {
        let succeeded: String
        if context.succeededSteps.isEmpty {
            succeeded = "  (none — the first step failed)"
        } else {
            succeeded = context.succeededSteps
                .map { "  - Step \($0.stepIndex + 1): \($0.tool) (completed)" }
                .joined(separator: "\n")
        }

        var prompt = """
        A test plan step failed. Here is the context:

        FAILED STEP: Step \(context.failedStepIndex + 1) using tool "\(context.failedTool)"
        ERROR: \(context.error)

        PREVIOUSLY SUCCEEDED STEPS:
        \(succeeded)
        """

        if let observation = context.failureObservation {
            var lines: [String] = []
            if let observeError = observation.observeError {
                lines.append("  observeError: \(observeError)")
            }
            if observation.awaitTimeout == true {
                lines.append("  awaitTimeout: true")
            }
            if let texts = observation.visibleTextsSample, !texts.isEmpty {
                lines.append("  visibleTexts: \(texts.prefix(40).joined(separator: ", "))")
            }
            if let ids = observation.resourceIdsSample, !ids.isEmpty {
                lines.append("  resourceIds: \(ids.prefix(40).joined(separator: ", "))")
            }
            if !lines.isEmpty {
                prompt += "\n\nDEVICE STATE AT FAILURE:\n" + lines.joined(separator: "\n")
            }
        }

        prompt += """


        PLAN YAML:
        \(context.planContent)

        You have a maximum of \(maxToolCalls) tool calls to recover the device state so the test can \
        resume from step \(context.failedStepIndex + 2). Focus on getting the device ready for the NEXT \
        step in the plan.
        """

        return prompt
    }

    // MARK: - Tool definitions (mirror the Android SimpleTool set; schemas from schemas/tool-definitions.json)

    static func buildToolDefinitions() -> [ToolDefinition] {
        let selectorSchema = ParameterSchema.object(
            properties: [
                "text": .string(description: "Visible text or accessibility label of the element"),
                "id": .string(description: "Resource id / accessibility identifier of the element"),
                "description": .string(description: "Accessibility description of the element"),
            ],
            description: "How to find the element — provide at least one of text, id, or description"
        )

        return [
            tool(
                name: "observe",
                description: "Capture the current screen state and UI hierarchy. Call this first.",
                properties: [:],
                required: []
            ),
            tool(
                name: "tapOn",
                description: "Tap an element located by text, id, or accessibility description.",
                properties: [
                    "selector": selectorSchema,
                    "action": .enumeration(
                        ["tap", "doubleTap", "longPress"],
                        description: "Gesture to perform; defaults to tap"
                    ),
                ],
                required: ["selector"]
            ),
            tool(
                name: "inputText",
                description: "Type text into the currently focused input field.",
                properties: [
                    "text": .string(description: "The text to type"),
                    "imeAction": .string(description: "Optional keyboard action to submit, e.g. done/next/search"),
                ],
                required: ["text"]
            ),
            tool(
                name: "clearText",
                description: "Clear text from the currently focused input field.",
                properties: [:],
                required: []
            ),
            tool(
                name: "pressButton",
                description: "Press a device or navigation button (e.g. back, home, enter).",
                properties: [
                    "button": .string(description: "The button to press, e.g. back, home, enter"),
                ],
                required: ["button"]
            ),
            tool(
                name: "swipeOn",
                description: "Swipe or scroll the screen in a direction to reveal off-screen content.",
                properties: [
                    "direction": .enumeration(
                        ["up", "down", "left", "right"],
                        description: "Direction to swipe/scroll"
                    ),
                ],
                required: ["direction"]
            ),
            tool(
                name: "launchApp",
                description: "Launch an app by its bundle/package id.",
                properties: [
                    "appId": .string(description: "The app bundle identifier / package name"),
                ],
                required: ["appId"]
            ),
            tool(
                name: "terminateApp",
                description: "Terminate a running app by its bundle/package id.",
                properties: [
                    "appId": .string(description: "The app bundle identifier / package name"),
                ],
                required: ["appId"]
            ),
        ]
    }

    private static func tool(
        name: String,
        description: String,
        properties: [String: ParameterSchema],
        required: [String]
    ) -> ToolDefinition {
        ToolDefinition(
            function: FunctionDefinition(
                name: name,
                description: description,
                parameters: ToolParameters.object(properties: properties, required: required),
                strict: false
            )
        )
    }

    // MARK: - Helpers

    static func parseArguments(_ json: String) -> [String: Any] {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = object as? [String: Any]
        else {
            return [:]
        }
        return dict
    }

    private static func escapeForJSON(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
    }

    private func elapsedMs(since start: TimeInterval) -> Int {
        Int((timer.now() - start) * 1000)
    }

}

// MARK: - Async bridge seam (for testability + bounded blocking)

/// Bridges a single async call to the synchronous XCTest executor thread with a **bound**. The
/// recovery loop drives the model call synchronously (matching how the executor already drives
/// `AutoMobileMCPClient`), but a hung model call must fail the recovery attempt rather than wedge
/// the runner forever (issue #5644). A seam so the handler's timeout handling is unit-testable with
/// a fake, and the production bound is testable directly with a tiny timeout.
protocol AsyncCallBridging {
    /// Runs `operation` and blocks the caller until it completes or `timeout` seconds elapse.
    /// Throws `RecoveryTimeoutError` on timeout; rethrows any error `operation` throws.
    func run<T>(timeout: TimeInterval, _ operation: @escaping () async throws -> T) throws -> T
}

/// Thrown when a bridged async call does not complete within its timeout.
struct RecoveryTimeoutError: Error, CustomStringConvertible, Equatable {
    let timeoutSeconds: TimeInterval
    var description: String { "Recovery model call timed out after \(timeoutSeconds)s" }
}

/// Production bridge: runs the async work on the cooperative pool and blocks the executor thread on a
/// **bounded** semaphore wait. Blocking the executor thread is safe (it is the XCTest thread, not a
/// cooperative-pool thread); the timeout guarantees the wait cannot block indefinitely. On timeout the
/// spawned `Task` is left to finish on its own — it can no longer affect the abandoned recovery attempt.
struct SemaphoreAsyncCallBridge: AsyncCallBridging {
    func run<T>(timeout: TimeInterval, _ operation: @escaping () async throws -> T) throws -> T {
        let box = ResultBox<T>()
        let semaphore = DispatchSemaphore(value: 0)
        let task = Task {
            do {
                box.result = .success(try await operation())
            } catch {
                box.result = .failure(error)
            }
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            // Cancel the abandoned work so a cancellation-aware provider can release its network
            // request and drop its retained state promptly, rather than one orphaned task per
            // timed-out recovery accumulating for the lifetime of the XCTest process.
            task.cancel()
            throw RecoveryTimeoutError(timeoutSeconds: timeout)
        }
        switch box.result {
        case let .success(value):
            return value
        case let .failure(error):
            throw error
        case .none:
            throw MCPClientError.requestFailed("Recovery model call produced no result")
        }
    }
}

/// Mutable, thread-crossing result holder for `SemaphoreAsyncCallBridge`. `@unchecked Sendable`
/// because access is serialized by the semaphore (the write happens-before `signal()`; the read
/// happens-after a successful `wait()`), and on timeout the box is never read again.
private final class ResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}
