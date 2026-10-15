import Foundation

struct SystemTimer: ProxyTimer {
    func now() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    func wait(milliseconds: Int64) async {
        try? await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000)
    }

    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(milliseconds))) {
            callback()
        }
    }
}
