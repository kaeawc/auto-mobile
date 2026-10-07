import Foundation

extension CommandHandler {
    // MARK: - Network Mocking

    func handleSetNetworkMockRules(
        _ request: RequestSetNetworkMockRules,
        startTime: Date
    )
        async -> SetNetworkMockRulesResponse
    {
        let succeeded = if await sdkServerInfoForTrackedForegroundApp() != nil {
            await sdkHierarchyClient?.setMockRules(request.rules) ?? false
        } else {
            false
        }
        return SetNetworkMockRulesResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleSetNetworkErrorSimulation(
        _ request: RequestSetNetworkErrorSimulation,
        startTime: Date
    )
        async -> SetNetworkErrorSimulationResponse
    {
        let config = NetworkErrorSimulationDTO(
            enabled: request.enabled,
            errorType: request.errorType,
            limit: request.limit,
            expiresAtEpochMs: request.expiresAtEpochMs
        )
        let succeeded = if await sdkServerInfoForTrackedForegroundApp() != nil {
            await sdkHierarchyClient?.setNetworkErrorSimulation(config) ?? false
        } else {
            false
        }
        return SetNetworkErrorSimulationResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleSetNetworkFaultRules(
        _ request: RequestSetNetworkFaultRules,
        startTime: Date
    )
        async -> SetNetworkFaultRulesResponse
    {
        let succeeded = if await sdkServerInfoForTrackedForegroundApp() != nil {
            await sdkHierarchyClient?.setNetworkFaultRules(request.rules) ?? false
        } else {
            false
        }
        return SetNetworkFaultRulesResponse(
            requestId: request.requestId,
            ok: succeeded,
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }

    func handleGetSdkCapabilities(
        _ request: RequestEnvelope,
        startTime: Date
    )
        async -> SdkCapabilitiesResponse
    {
        guard let serverInfo = await sdkServerInfoForTrackedForegroundApp() else {
            return SdkCapabilitiesResponse(
                requestId: request.requestId,
                available: false,
                bundleId: nil,
                capabilities: [],
                totalTimeMs: totalTimeMs(from: startTime)
            )
        }

        var capabilities = SdkCapability.allCases
        if !serverInfo.capabilities.contains("network-fault-rules") {
            capabilities.removeAll { $0 == .networkFaultRules }
        }
        if !serverInfo.capabilities.contains("magic-tap") {
            capabilities.removeAll { $0 == .magicTap }
        }
        return SdkCapabilitiesResponse(
            requestId: request.requestId,
            available: true,
            bundleId: normalizedBundleId(serverInfo.bundleId),
            capabilities: capabilities.map(\.rawValue),
            totalTimeMs: totalTimeMs(from: startTime)
        )
    }
}
