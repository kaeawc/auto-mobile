import Darwin
import Foundation

extension DaemonManager {
    /// Build a single newline-framed `daemon_request` line. Extracted (the reference built this dict
    /// inline) so the frozen wire envelope — keys `{id, type:"daemon_request", method, params,
    /// clientVersion}` plus the trailing `\n` framing — is unit-testable without a socket.
    static func buildDaemonRequestLine(
        id: String,
        method: String,
        params: [String: Any],
        clientVersion: String
    ) -> String? {
        let request: [String: Any] = [
            "id": id,
            "type": "daemon_request",
            "method": method,
            "params": params,
            // Declared for the daemon's server-side version handshake gate (#2744).
            "clientVersion": clientVersion,
        ]
        guard let requestData = try? JSONSerialization.data(withJSONObject: request),
              var requestLine = String(data: requestData, encoding: .utf8)
        else {
            return nil
        }
        requestLine.append("\n")
        return requestLine
    }

    public static func releaseSession(_ sessionId: String) -> Bool {
        guard isDaemonRunning() else {
            print("[AutoMobile] Cannot release session: daemon not running")
            return false
        }

        guard let requestLine = buildDaemonRequestLine(
            id: UUID().uuidString,
            method: "daemon/releaseSession",
            params: ["sessionId": sessionId],
            clientVersion: resolveDaemonClientVersion()
        ) else {
            print("[AutoMobile] Failed to serialize release session request")
            return false
        }

        let result = sendDaemonRequest(requestLine, timeoutSeconds: 5)
        if let result = result, let success = result["success"] as? Bool, success {
            if let resultData = result["result"] as? [String: Any],
               let alreadyReleased = resultData["alreadyReleased"] as? Bool,
               alreadyReleased
            {
                print("[AutoMobile] Session \(sessionId) was already released (auto-released by daemon)")
            } else {
                print("[AutoMobile] Session \(sessionId) released")
            }
            return true
        }
        if let result = result, let error = result["error"] as? String {
            print("[AutoMobile] Failed to release session \(sessionId): \(error)")
        } else {
            print("[AutoMobile] Failed to release session \(sessionId)")
        }
        return false
    }

    public static func refreshDevicePool(timeoutSeconds: TimeInterval = 30) -> RefreshDevicesResult {
        PerfTimer.log("refreshDevicePool START")
        guard isDaemonRunning() else {
            PerfTimer.log("refreshDevicePool: daemon not running")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        guard let requestLine = buildDaemonRequestLine(
            id: UUID().uuidString,
            method: "daemon/refreshDevices",
            params: [String: Any](),
            clientVersion: resolveDaemonClientVersion()
        ) else {
            PerfTimer.log("refreshDevicePool: failed to serialize request")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        PerfTimer.log("refreshDevicePool: sending daemon request")
        let result = sendDaemonRequest(requestLine, timeoutSeconds: timeoutSeconds)
        guard let result = result,
              let success = result["success"] as? Bool, success,
              let resultData = result["result"] as? [String: Any]
        else {
            PerfTimer.log("refreshDevicePool: request failed")
            return RefreshDevicesResult(success: false, addedDevices: 0, totalDevices: 0, availableDevices: 0)
        }

        let addedDevices = resultData["addedDevices"] as? Int ?? 0
        let totalDevices = resultData["totalDevices"] as? Int ?? 0
        let availableDevices = resultData["availableDevices"] as? Int ?? 0

        PerfTimer.log("refreshDevicePool END: +\(addedDevices) devices, \(availableDevices)/\(totalDevices) available")
        return RefreshDevicesResult(
            success: true,
            addedDevices: addedDevices,
            totalDevices: totalDevices,
            availableDevices: availableDevices
        )
    }

    /// Copy a Unix socket path into `addr.sun_path` without overflowing the fixed
    /// buffer. `sun_path` is a fixed C array (104 bytes on Darwin); the previous
    /// unbounded `strcpy` overflowed the stack `sockaddr_un` for env-supplied
    /// paths longer than the buffer (issue #3625). Returns `false` (leaving `addr`
    /// unchanged) when the path plus its NUL terminator does not fit.
    static func setSocketPath(_ path: String, into addr: inout sockaddr_un) -> Bool {
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let bytes = Array(path.utf8)
        // Need room for the trailing NUL, so the path itself must be < capacity.
        guard bytes.count < capacity else { return false }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                for (i, byte) in bytes.enumerated() {
                    dst[i] = CChar(bitPattern: byte)
                }
                dst[bytes.count] = 0
            }
        }
        return true
    }

    private static func sendDaemonRequest(_ request: String, timeoutSeconds: TimeInterval) -> [String: Any]? {
        let socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            print("[AutoMobile] Failed to create socket")
            return nil
        }
        defer { Darwin.close(socketFd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        guard Self.setSocketPath(socketPath, into: &addr) else {
            print("[AutoMobile] Daemon socket path too long (\(socketPath.utf8.count) bytes): \(socketPath)")
            return nil
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.connect(socketFd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard connectResult == 0 else {
            print("[AutoMobile] Failed to connect to daemon socket: \(errno)")
            return nil
        }

        // Set socket timeout
        var tv = timeval(tv_sec: Int(timeoutSeconds), tv_usec: 0)
        setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        guard let requestData = request.data(using: .utf8) else {
            return nil
        }
        let written = requestData.withUnsafeBytes { ptr in
            Darwin.write(socketFd, ptr.baseAddress, ptr.count)
        }
        guard written == requestData.count else {
            print("[AutoMobile] Failed to write request to socket")
            return nil
        }

        var buffer = Data()
        let readBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { readBuffer.deallocate() }

        while true {
            let bytesRead = Darwin.read(socketFd, readBuffer, 4096)
            if bytesRead > 0 {
                buffer.append(readBuffer, count: bytesRead)
                if let responseStr = String(data: buffer, encoding: .utf8),
                   responseStr.contains("\n")
                {
                    let lines = responseStr.split(separator: "\n", maxSplits: 1)
                    if let firstLine = lines.first,
                       let lineData = String(firstLine).data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
                    {
                        return json
                    }
                }
            } else {
                break
            }
        }

        print("[AutoMobile] Timeout or error waiting for daemon response")
        return nil
    }
}
