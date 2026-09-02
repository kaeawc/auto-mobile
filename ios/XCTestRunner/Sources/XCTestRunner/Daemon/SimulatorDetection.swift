import Foundation

/// Fast check for whether any iOS simulator is currently booted, via `xcrun simctl`. Stateless
/// namespace; the blocking `Process` call is made synchronously by the caller off any actor.
enum SimulatorDetection {
    /// Check if any iOS simulator is currently booted (fast check)
    static func hasBootedSimulator() -> Bool {
        PerfTimer.log("hasBootedSimulator: starting xcrun simctl")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "list", "devices", "booted", "--json"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            // Drain the pipe before reaping: `readDataToEndOfFile` blocks until the child closes the
            // write end at exit, so reading first lets the child write freely. Waiting first would
            // deadlock if simctl's output exceeded the ~64 KB pipe buffer (child blocks on write while
            // we block in `waitUntilExit`), on a synchronous path with no timeout.
            PerfTimer.log("hasBootedSimulator: reading simctl output")
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()

            guard process.terminationStatus == 0 else {
                PerfTimer.log("hasBootedSimulator: simctl failed with status \(process.terminationStatus)")
                return false
            }

            PerfTimer.log("hasBootedSimulator: parsing \(data.count) bytes of JSON")
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let devices = json["devices"] as? [String: [[String: Any]]]
            else {
                PerfTimer.log("hasBootedSimulator: failed to parse JSON")
                return false
            }

            var bootedCount = 0
            for (_, deviceList) in devices {
                bootedCount += deviceList.count
            }
            PerfTimer.log("hasBootedSimulator: found \(bootedCount) booted simulators")
            return bootedCount > 0
        } catch {
            PerfTimer.log("hasBootedSimulator: ERROR - \(error)")
            return false
        }
    }
}
