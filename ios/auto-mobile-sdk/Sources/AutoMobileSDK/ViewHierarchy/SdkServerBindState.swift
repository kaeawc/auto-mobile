#if DEBUG && !os(watchOS)
    enum SdkServerBindState: Equatable, Sendable {
        case notStarted
        case starting
        case started(port: UInt16)
        case failed(attemptedPorts: [UInt16], lastReason: String)
    }

    /// Pure primary-listener reducer. The server performs the returned bind effect
    /// through its injected factory, then feeds readiness or failure back here.
    struct SdkBindPlanner: Equatable, Sendable {
        enum Event {
            case start
            case ready(UInt16)
            case failed(String)
        }

        var state: SdkServerBindState = .notStarted
        var attemptedPorts: [UInt16] = []

        func next(_ event: Event, udid: String?) -> (planner: SdkBindPlanner, port: UInt16?) {
            switch event {
            case .start:
                return candidate(udid: udid, attemptedPorts: [])
            case let .ready(port):
                guard state == .starting, attemptedPorts.last == port else { return (self, nil) }
                return (Self(state: .started(port: port), attemptedPorts: attemptedPorts), nil)
            case let .failed(reason):
                switch state {
                case .notStarted, .failed:
                    return (self, nil)
                case .starting, .started:
                    break
                }
                let count = udid == nil ? 1 : SdkSimulatorPort.probeCount
                if attemptedPorts.count < count {
                    return candidate(udid: udid, attemptedPorts: attemptedPorts)
                }
                return (Self(
                    state: .failed(attemptedPorts: attemptedPorts, lastReason: reason),
                    attemptedPorts: attemptedPorts
                ), nil)
            }
        }

        private func candidate(
            udid: String?, attemptedPorts: [UInt16]
        )
            -> (planner: SdkBindPlanner, port: UInt16?)
        {
            let port = udid.map {
                SdkSimulatorPort.simulatorPort(udid: $0, attempt: attemptedPorts.count)
            } ?? SdkHierarchyServer.port
            return (Self(state: .starting, attemptedPorts: attemptedPorts + [port]), port)
        }
    }
#endif
