#if canImport(Network)
    import Network

    /// NWPathMonitor behind `/platform/connectivity` (#14273). It needs no entitlement, so the
    /// injected agent and the Viewer can both run it; the monitor starts on the module's first read.
    @MainActor
    final class NWPathConnectivitySource: PrototypeConnectivitySource {
        private var monitor: NWPathMonitor?

        func start(_ update: @escaping @MainActor @Sendable (PrototypeConnectivityReading) -> Void) {
            guard monitor == nil else { return }
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                let reading = Self.reading(path)
                Task { @MainActor in update(reading) }
            }
            monitor.start(queue: .main)
            self.monitor = monitor
        }

        func stop() {
            monitor?.cancel()
            monitor = nil
        }

        nonisolated static func reading(_ path: NWPath) -> PrototypeConnectivityReading {
            let types: [(NWInterface.InterfaceType, PrototypeConnectivityReading.Interface)] = [
                (.wifi, .wifi), (.cellular, .cellular), (.wiredEthernet, .wiredEthernet), (.other, .other),
            ]
            return PrototypeConnectivityReading(
                satisfied: path.status == .satisfied,
                interfaces: Set(types.filter { path.usesInterfaceType($0.0) }.map(\.1)),
                expensive: path.isExpensive,
                constrained: path.isConstrained
            )
        }
    }
#endif
