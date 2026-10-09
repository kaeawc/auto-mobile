import Foundation

/// Loads a plan, resolves its platform/devices, drives the daemon over an `AutoMobileMCPClient` to run
/// it, and — on failure, when enabled — hands off to an AI recovery handler and resumes.
///
/// Async execution owns an explicit session value: the caller's ID or a fresh ID for this run.
/// The injected idGenerator supplies one fresh ID when the caller does not provide a sessionUuid.
/// Immutable dependencies refine Sendable; execution state and wire arguments remain local to a run.
/// Concurrent runs require distinct transport clients if their session lifetimes must be independent.
public final class AutoMobilePlanExecutor: Sendable {
    private let configuration: Configuration
    private let planLoader: AutoMobilePlanLoading
    private let mcpClient: AutoMobileMCPClient
    private let deadlineScheduler: any DeadlineScheduler
    private let logger: AutoMobileLogger
    private let daemonEnsurer: AutoMobileDaemonEnsuring
    private let idGenerator: @Sendable () -> String
    private static let daemonEnsureQueue = DispatchQueue(
        label: "com.automobile.xctestrunner.daemon-ensure",
        qos: .utility,
        attributes: .concurrent
    )
    private let recoveryConfigProvider: RecoveryConfigProviding
    // Nil = no AI recovery (no injected handler and no model API key in the environment); the executor
    // then behaves exactly as it did before this feature — a failed step throws.
    private let recoveryHandler: PlanRecoveryHandler?
    // Heartbeats and releases a session the daemon held for recovery (#10834 / #11072). Nil (HTTP
    // transport) never asks the daemon to hold a failed attempt's session.
    private let heldSessionController: HeldSessionControlling?

    public init(
        configuration: Configuration,
        planLoader: AutoMobilePlanLoading = DefaultPlanLoader(),
        mcpClient: AutoMobileMCPClient? = nil,
        timer: AutoMobileTimer = SystemTimer(),
        logger: AutoMobileLogger = StdoutLogger(),
        recoveryHandler: PlanRecoveryHandler? = nil,
        recoveryConfigProvider: RecoveryConfigProviding? = nil,
        recoveryModelConfig: RecoveryModelConfig? = RecoveryModelConfig.resolve(),
        daemonEnsurer: AutoMobileDaemonEnsuring = SystemDaemonEnsurer(),
        deadlineScheduler: any DeadlineScheduler = SystemDeadlineScheduler(),
        idGenerator: @escaping @Sendable () -> String = { UUID().uuidString },
        heldSessionController: HeldSessionControlling? = nil
    ) {
        self.deadlineScheduler = deadlineScheduler
        self.configuration = configuration
        self.planLoader = planLoader
        self.logger = logger
        self.daemonEnsurer = daemonEnsurer
        self.idGenerator = idGenerator
        if let heldSessionController = heldSessionController {
            self.heldSessionController = heldSessionController
        } else if case let .daemonUnixSocket(path) = configuration.transport {
            self.heldSessionController = DaemonSocketHeldSessionController(socketPath: path)
        } else {
            self.heldSessionController = nil
        }

        if let mcpClient = mcpClient {
            self.mcpClient = mcpClient
        } else {
            switch configuration.transport {
            case let .daemonUnixSocket(path):
                self.mcpClient = AutoMobileDaemonClient(
                    socketPath: path,
                    logger: logger,
                    clientVersion: DaemonManager.resolveDaemonClientVersion(repoRoot: configuration.daemonRepoRoot)
                )
            case let .streamableHttp(url):
                do {
                    self.mcpClient = try StreamableHTTPMCPClient(endpoint: url, logger: logger)
                } catch {
                    self.mcpClient = FailingMCPClient(error: error)
                }
            }
        }

        // Recovery config provider reads the `ai-recovery` feature flag over the same MCP client the
        // plan runs on. Consulted only when a handler exists (see handleFailure), so no extra daemon
        // traffic in the common no-recovery path.
        let resolvedClient = self.mcpClient
        self.recoveryConfigProvider = recoveryConfigProvider
            ?? DaemonRecoveryConfigProvider(clientProvider: { resolvedClient }, logger: logger)

        // Auto-wire the Tachikoma handler only when recovery can actually run — a model API key must be
        // present. Without a key (CI, most unit tests) the handler stays nil and behavior is unchanged.
        if let recoveryHandler = recoveryHandler {
            self.recoveryHandler = recoveryHandler
        } else if let recoveryModelConfig = recoveryModelConfig {
            self.recoveryHandler = TachikomaPlanRecoveryHandler(
                mcpClient: resolvedClient,
                configProvider: self.recoveryConfigProvider,
                modelConfig: recoveryModelConfig,
                timer: timer,
                logger: logger,
                deadlineScheduler: deadlineScheduler
            )
        } else {
            self.recoveryHandler = nil
        }
    }

    public func execute(
        testMetadata: TestMetadata? = nil,
        sessionUuid: String? = nil
    )
        async throws -> ExecutePlanResult
    {
        // Resolve identity once, before suspension, and reuse it across retries and recovery.
        let sessionUuid = sessionUuid ?? idGenerator()
        return try await executeWithRetries(testMetadata: testMetadata, sessionUuid: sessionUuid)
    }

    private func executeWithRetries(
        testMetadata: TestMetadata?,
        sessionUuid: String
    )
        async throws -> ExecutePlanResult
    {
        try Task.checkCancellation()
        var lastError: Error?

        // Preflight the daemon before the first attempt so a stale/version-skewed daemon on the
        // shared socket is restarted even with the default retryCount of 0, which never enters the
        // retry branch below (#2744). Only when the configured socket is the one DaemonManager
        // manages (its env/default path) — a custom socket path is the caller's own daemon that
        // DaemonManager can't target. No-op for HTTP transport.
        if case let .daemonUnixSocket(path) = configuration.transport, path == DaemonManager.socketPath {
            try await ensureDaemonRunning()
        }

        for attempt in 0 ... configuration.retryCount {
            do {
                if attempt > 0 {
                    logger.info("Retry attempt \(attempt + 1) of \(configuration.retryCount + 1)")
                }
                // A transient retry runs under a fresh session (#11072), as on Android: the failed
                // attempt's session was released (by the daemon, or by this runner when it was held
                // for recovery), and a released UUID is terminal on the daemon.
                return try await executeAttempt(
                    startStep: configuration.startStep,
                    recoveryAlreadyAttempted: false,
                    deviceIdOverride: nil,
                    sessionUuidOverride: attempt == 0 ? sessionUuid : idGenerator(),
                    testMetadata: testMetadata
                )
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                try Task.checkCancellation()
                lastError = error
                let shouldRetry = shouldRetry(error: error, attempt: attempt)
                logger.warn("Plan execution attempt \(attempt + 1) failed: \(error)")
                if shouldRetry {
                    try await recoverDaemonBeforeRetry()
                    try await deadlineScheduler.sleep(seconds: configuration.retryDelaySeconds)
                } else {
                    break
                }
            }
        }

        if let error = lastError {
            throw error
        }
        throw ExecutorError.executionFailed("Unknown failure")
    }

    /// Before retrying a failed plan execution over the daemon socket, restart a version-skewed
    /// daemon via the version-matched ensure path (#2744) and drop the stale session, so a handshake
    /// rejection self-heals instead of failing every retry against the same wrong-version daemon.
    /// No-op for HTTP transport, which does not share the per-uid daemon socket.
    private func recoverDaemonBeforeRetry() async throws {
        guard case let .daemonUnixSocket(path) = configuration.transport else {
            return
        }
        // Only the DaemonManager-managed (env/default) socket can be restarted here; for a custom
        // socket path (the caller's own daemon) just drop the session so the retry reconnects.
        if path == DaemonManager.socketPath {
            try await ensureDaemonRunning()
        }
        try Task.checkCancellation()
        mcpClient.resetSession()
    }

    /// The synchronous ensurer may block for seconds. Keep it off the cooperative pool and allow
    /// cancellation to finish the await without joining it. The cell ignores any late completion
    /// and resumes outside its lock; no executor state is changed by the background call.
    private func ensureDaemonRunning() async throws {
        try Task.checkCancellation()
        let completion = SingleResumeCell<Void>()
        let ensurer = daemonEnsurer
        let repoRoot = configuration.daemonRepoRoot
        Self.daemonEnsureQueue.async {
            guard !completion.isResolved else { return }
            _ = ensurer.ensureDaemonRunning(repoRoot: repoRoot)
            completion.resume(returning: ())
        }
        try await completion.wait()
        try Task.checkCancellation()
    }

    /// Execute the plan once from `startStep`. On a step failure, if AI recovery is enabled and has not
    /// yet been attempted for this test, hand the failure to the recovery handler and — on success —
    /// resume from the step after the failed one (see `handleFailure`). `sessionUuidOverride` lets a
    /// resume reuse the failed attempt's session so it continues on the same device; the transient
    /// retry loop also reuses the one explicit session value captured by execute().
    private func executeAttempt(
        startStep: Int,
        recoveryAlreadyAttempted: Bool,
        deviceIdOverride: String?,
        sessionUuidOverride: String,
        testMetadata: TestMetadata?
    )
        async throws -> ExecutePlanResult
    {
        try Task.checkCancellation()
        PerfTimer
            .log("executeAttempt START (startStep=\(startStep), recoveryAlreadyAttempted=\(recoveryAlreadyAttempted))")
        let planContent: String
        do {
            planContent = try PerfTimer.measure("loadPlan") {
                try planLoader.loadPlan(at: configuration.planPath, bundle: configuration.planBundle)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as PlanLoaderError {
            throw ExecutorError.planNotFound(error.description)
        } catch {
            throw ExecutorError.planNotFound(error.localizedDescription)
        }
        PerfTimer.log("planContent loaded, length=\(planContent.count) chars")

        let substituted = try PerfTimer.measure("substituteParameters") {
            try PlanParameterSubstitutor.substitute(in: planContent, parameters: configuration.parameters)
        }
        let planMetadata = try PerfTimer.measure("parsePlanMetadata") {
            try PlanMetadataParser.parse(from: substituted)
        }

        // Values to redact from any recovery context that leaves the process for the LLM provider
        // (issue #6029). Parse the declared secret keys from the RAW plan (tolerant of `${...}` and
        // immune to substitution truncation), union the caller-configured ones, and resolve any
        // `${...}` inside the key names. The concrete strings to scrub are derived from THIS executor's
        // own substitution — the single source of truth for what actually landed — so the scrub target
        // always equals the recovery context. The `substituted` string keeps the real values for the
        // daemon.
        let secretValues = SecretRedaction.secretValues(
            resolveSecretValues(rawPlan: planContent)
        )
        PerfTimer
            .log(
                "planMetadata: platform=\(planMetadata.platform.map { String(describing: $0) } ?? "nil"), hasDevices=\(planMetadata.hasDevices), deviceLabels=\(planMetadata.deviceLabels)"
            )

        let platform = try resolvePlatform(from: planMetadata)
        PerfTimer.log("resolved platform=\(platform)")

        let sessionUuid = sessionUuidOverride
        PerfTimer.log("sessionUuid=\(sessionUuid)")

        // Ask the daemon to keep this attempt's session and device on failure only when AI recovery
        // may follow (#10834 / #11072); every path that does not resume on it releases it.
        let holdForRecovery = await recoveryMayFollow(
            recoveryAlreadyAttempted: recoveryAlreadyAttempted,
            testMetadata: testMetadata
        )

        var arguments = PerfTimer.measure("buildExecutePlanArguments") {
            buildExecutePlanArguments(
                planContent: substituted,
                sessionUuid: sessionUuid,
                platform: platform,
                startStep: startStep,
                deviceIdOverride: deviceIdOverride,
                deviceLabels: planMetadata.deviceLabels,
                testMetadata: testMetadata
            )
        }
        if holdForRecovery {
            arguments["holdSessionOnFailure"] = true
        }
        PerfTimer.log("arguments built, keys=\(arguments.keys.sorted())")

        do {
            try Task.checkCancellation()
            try await mcpClient.initialize(timeout: configuration.timeoutSeconds)
            try Task.checkCancellation()
            _ = try await mcpClient.callTool(
                name: "setToolEnabled",
                arguments: ["toolName": "executePlan", "sessionUuid": sessionUuid],
                timeout: configuration.timeoutSeconds
            )
            try Task.checkCancellation()
            let result: ExecutePlanResult
            do {
                let response = try await mcpClient.callTool(
                    name: "executePlan", arguments: arguments, timeout: configuration.timeoutSeconds
                )
                try Task.checkCancellation()
                PerfTimer.log("executePlan response received, length=\(response.text.count) chars")
                result = try PerfTimer.measure("decodeExecutePlanResult") {
                    try decodeExecutePlanResult(from: response.text)
                }
            } catch {
                // No failure result reaches recovery, so a session the daemon may hold is freed now.
                if holdForRecovery {
                    await releaseHeldSession(sessionUuid)
                }
                throw error
            }
            PerfTimer
                .log(
                    "executeAttempt END - success=\(result.success), steps=\(result.executedSteps)/\(result.totalSteps)"
                )
            if result.success {
                return result
            }
            return try await handleFailure(
                result: result,
                planContent: substituted,
                secretValues: secretValues,
                platform: platform,
                sessionUuid: sessionUuid,
                deviceIdOverride: deviceIdOverride,
                recoveryAlreadyAttempted: recoveryAlreadyAttempted,
                testMetadata: testMetadata,
                sessionHeld: holdForRecovery
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as MCPClientError {
            try Task.checkCancellation()
            PerfTimer.log("executeAttempt ERROR: MCPClientError - \(error.description)")
            throw ExecutorError.mcpFailure(error.description)
        } catch let error as ExecutorError {
            PerfTimer.log("executeAttempt ERROR: ExecutorError - \(error)")
            throw error
        } catch {
            PerfTimer.log("executeAttempt ERROR: \(error.localizedDescription)")
            throw ExecutorError.executionFailed(error.localizedDescription)
        }
    }

    /// Handle a failed `executePlan` result: gate AI recovery, and on a successful recovery resume the
    /// plan from the step after the failed one. Mirrors the Android runner's `handleFailure`. When
    /// recovery is not eligible or does not succeed, throws the same `ExecutorError.executionFailed` the
    /// executor threw before this feature existed.
    private func handleFailure(
        result: ExecutePlanResult,
        planContent: String,
        secretValues: [String],
        platform: PlanPlatform,
        sessionUuid: String,
        deviceIdOverride: String?,
        recoveryAlreadyAttempted: Bool,
        testMetadata: TestMetadata?,
        sessionHeld: Bool
    )
        async throws -> ExecutePlanResult
    {
        let failureMessage = buildFailureMessage(from: result)
        // Only the resumed plan takes over a held session (and releases it when it ends); every other
        // outcome releases it here.
        let releaseHeld = { [self] in
            if sessionHeld {
                await releaseHeldSession(sessionUuid)
            }
        }

        // Cheap local gates first; the feature-flag read (which may hit the daemon) is last and runs
        // only when a handler is present, so the no-recovery path adds zero daemon traffic.
        guard configuration.aiAssistance,
              !recoveryAlreadyAttempted,
              let handler = recoveryHandler,
              let failedStep = result.failedStep,
              failedStep.stepIndex >= 0,
              !(testMetadata?.isCi ?? false),
              await recoveryConfigProvider.isRecoveryEnabled()
        else {
            await releaseHeld()
            throw ExecutorError.executionFailed(failureMessage)
        }

        logger.info("Attempting AI-assisted recovery for failed step \(failedStep.stepIndex + 1) (\(failedStep.tool))")
        let context = buildFailedStepContext(
            failedStep: failedStep,
            planContent: planContent,
            secretValues: secretValues,
            platform: platform,
            sessionUuid: sessionUuid,
            deviceIdOverride: deviceIdOverride
        )

        do {
            try Task.checkCancellation()
        } catch {
            await releaseHeld()
            throw error
        }
        // Keep the held session alive while recovery's calls (which carry it) drive the device, or the
        // daemon's heartbeat lease frees it mid-recovery.
        let heartbeat = sessionHeld ? heldSessionController?.startHeartbeating(sessionId: sessionUuid) : nil
        let outcome = await handler.attemptRecovery(context)
        heartbeat?.stop()
        do {
            try Task.checkCancellation()
        } catch {
            await releaseHeld()
            throw error
        }
        if !outcome.success {
            logger.warn("AI recovery failed")
            await releaseHeld()
            throw ExecutorError.executionFailed("\(failureMessage)\n  AI recovery attempted but did not succeed.")
        }

        // Recovery succeeded — resume from the next step, pinned to the recovered device and the same
        // session. `recoveryAlreadyAttempted: true` prevents a second recovery within this attempt.
        let resumeStep = failedStep.stepIndex + 1
        logger.info("AI recovery succeeded, resuming plan from step \(resumeStep + 1)")
        var resumeResult = try await executeAttempt(
            startStep: resumeStep,
            recoveryAlreadyAttempted: true,
            deviceIdOverride: context.deviceId,
            sessionUuidOverride: sessionUuid,
            testMetadata: testMetadata
        )
        resumeResult.aiRecoveryAttempted = true
        resumeResult.aiRecoverySuccessful = resumeResult.success
        return resumeResult
    }

    /// Whether a failure of this attempt would go on to AI recovery (see `handleFailure`); the feature
    /// flag, which may hit the daemon, is read last and only when a handler exists.
    private func recoveryMayFollow(recoveryAlreadyAttempted: Bool, testMetadata: TestMetadata?) async -> Bool {
        guard configuration.aiAssistance,
              !recoveryAlreadyAttempted,
              recoveryHandler != nil,
              heldSessionController != nil,
              !(testMetadata?.isCi ?? false)
        else {
            return false
        }
        return await recoveryConfigProvider.isRecoveryEnabled()
    }

    private func releaseHeldSession(_ sessionUuid: String) async {
        logger.info("Releasing session \(sessionUuid) held for AI recovery")
        await heldSessionController?.release(sessionId: sessionUuid)
    }

    private func buildFailedStepContext(
        failedStep: FailedStep,
        planContent: String,
        secretValues: [String],
        platform: PlanPlatform,
        sessionUuid: String,
        deviceIdOverride: String?
    )
        -> FailedStepContext
    {
        // Sequential execution stops at the first failure, so every step before failedStep.stepIndex
        // completed. Reconstruct their tool names from the plan for the agent prompt (best effort). A
        // step's `tool` can itself be a substituted `${secret}` value, so scrub the reconstructed tool
        // names too (issue #6029 review).
        let stepTools = PlanStepToolParser.toolNames(from: planContent)
        var succeeded: [SucceededStepSummary] = []
        var index = 0
        while index < failedStep.stepIndex {
            let tool = index < stepTools.count ? stepTools[index] : "step"
            succeeded.append(SucceededStepSummary(
                stepIndex: index,
                tool: SecretRedaction.redact(tool, secretValues: secretValues)
            ))
            index += 1
        }

        // Egress boundary (issue #6029): every field placed on the context is forwarded to the LLM
        // provider by the recovery handler, so mask secret values out of the plan YAML, the failure
        // error, the (possibly substituted) tool name, and the sampled on-screen text/ids here — the
        // daemon's base64 payload above kept the real values.
        return FailedStepContext(
            failedStepIndex: failedStep.stepIndex,
            failedTool: SecretRedaction.redact(failedStep.tool, secretValues: secretValues),
            error: SecretRedaction.redact(failedStep.error, secretValues: secretValues),
            succeededSteps: succeeded,
            planContent: SecretRedaction.redact(planContent, secretValues: secretValues),
            platform: platform.rawValue,
            sessionUuid: sessionUuid,
            deviceId: failedStep.device ?? deviceIdOverride,
            failureObservation: SecretRedaction.redact(failedStep.failureObservation, secretValues: secretValues),
            // Carry the secret values into the recovery loop so it can scrub the DYNAMIC tool/observe
            // results it re-sends to the LLM (issue #6094). These are not forwarded to the provider —
            // only used as the redaction target for `executeTool` / `observeDeviceState` output.
            secretValues: secretValues
        )
    }

    private func buildExecutePlanArguments(
        planContent: String,
        sessionUuid: String,
        platform: PlanPlatform,
        startStep: Int,
        deviceIdOverride: String?,
        deviceLabels: [String],
        testMetadata: TestMetadata?
    )
        -> [String: Any]
    {
        let base64Content = Data(planContent.utf8).base64EncodedString()
        var args: [String: Any] = [
            "planContent": "base64:\(base64Content)",
            "platform": platform.rawValue,
            "startStep": startStep,
            "sessionUuid": sessionUuid,
        ]

        // Pin a resumed plan to the device the recovery agent just fixed (single-device path).
        if let deviceIdOverride = deviceIdOverride {
            args["deviceId"] = deviceIdOverride
        }

        if let cleanup = configuration.cleanup {
            args["cleanupAppId"] = cleanup.appId
            args["cleanupClearAppData"] = cleanup.clearAppData
        }

        if !deviceLabels.isEmpty {
            args["devices"] = deviceLabels
        }

        if let metadata = testMetadata {
            var metadataArgs: [String: Any] = [
                "testClass": metadata.testClass,
                "testMethod": metadata.testMethod,
            ]
            if let appVersion = metadata.appVersion {
                metadataArgs["appVersion"] = appVersion
            }
            if let gitCommit = metadata.gitCommit {
                metadataArgs["gitCommit"] = gitCommit
            }
            if let isCi = metadata.isCi {
                metadataArgs["isCi"] = isCi
            }
            args["testMetadata"] = metadataArgs
        }

        return args
    }

    /// The concrete secret strings to scrub, derived entirely from THIS executor's substitution so
    /// they always equal what landed in the recovery context (issue #6029). Secret keys come from the
    /// caller config plus the RAW plan's `secretParameters:` (parsed placeholder-tolerantly); any
    /// `${...}` inside a key name is resolved with the same substitution; and for each key both its raw
    /// parameter value and its actual substituted value (`PlanParameterSubstitutor.substituteText` applied to the bare
    /// `${key}`, matching the ordered single pass exactly) are collected.
    private func resolveSecretValues(rawPlan: String) -> [String] {
        let declaredKeys = configuration.secretParameterKeys
            .union(PlanMetadataParser.parseSecretParameterKeys(from: rawPlan))
        guard !declaredKeys.isEmpty else {
            return []
        }
        let params = configuration.parameters
        let resolvedKeys = Set(declaredKeys.map { PlanParameterSubstitutor.substituteText(in: $0, parameters: params) })

        // Raw parameter values via the lenient/fail-safe matcher (so an exotically-encoded key name
        // cannot leak), plus each key's actual substituted value from this executor's ordered pass.
        var values = SecretRedaction.secretParameterValues(declaredKeys: resolvedKeys, parameters: params)
        for key in resolvedKeys {
            let placeholder = "${\(key)}"
            let landed = PlanParameterSubstitutor.substituteText(in: placeholder, parameters: params)
            if landed != placeholder, !landed.isEmpty {
                values.append(landed)
            }
        }
        return values
    }

    private func decodeExecutePlanResult(from text: String) throws -> ExecutePlanResult {
        guard let data = text.data(using: .utf8) else {
            throw ExecutorError.invalidResponse("Response text is not valid UTF-8")
        }
        do {
            return try JSONDecoder().decode(ExecutePlanResult.self, from: data)
        } catch {
            throw ExecutorError.invalidResponse("Failed to decode executePlan response: \(error)")
        }
    }

    private func shouldRetry(error: Error, attempt: Int) -> Bool {
        if attempt >= configuration.retryCount {
            return false
        }
        if let executorError = error as? ExecutorError {
            return executorError.isRetryable
        }
        if let mcpError = error as? MCPClientError {
            return mcpError.isRetryable
        }
        return true
    }

    private func buildFailureMessage(from result: ExecutePlanResult) -> String {
        var message = ""
        if let failedStep = result.failedStep {
            message += "Test plan execution failed at step \(failedStep.stepIndex + 1) (\(failedStep.tool)):"
            message += "\n  Error: \(failedStep.error)"
            message += "\n  Executed: \(result.executedSteps)/\(result.totalSteps) steps"
            if let device = failedStep.device {
                message += "\n  Device: \(device)"
            }
        } else {
            message = result.error ?? "AutoMobile plan failed"
        }
        return message
    }
}

extension AutoMobilePlanExecutor {
    private func resolvePlatform(from metadata: PlanMetadata) throws -> PlanPlatform {
        if metadata.hasDevices {
            let platforms = Set(metadata.devicePlatforms.values)
            if platforms.count > 1 {
                throw ExecutorError.invalidPlan(
                    "Multi-device plans with mixed platforms are not supported by XCTestRunner."
                )
            }
            if let onlyPlatform = platforms.first {
                if let declared = metadata.platform, declared != onlyPlatform {
                    throw ExecutorError.invalidPlan(
                        "Plan platform '\(declared.rawValue)' does not match device platform '\(onlyPlatform.rawValue)'."
                    )
                }
                return onlyPlatform
            }
        }

        if let declared = metadata.platform {
            return declared
        }

        return configuration.defaultPlatform
    }
}
