/**
 * dsh-mac-tools — native SMC sampler.
 *
 * Long-running helper compiled once with `swiftc` (together with
 * `smc-core.swift`) and spawned by `src/smc.js`. It opens the public IOKit
 * `AppleSMC` user client (read access needs no privileges), enumerates the SMC
 * key space once, then prints one JSON line per sample on stdout:
 *
 *   {"at":1761220333000,"fanCount":1,"fans":[…],"temperatures":[…]}
 *
 * Usage: smc-sampler --interval-ms 1000 [--once]
 *
 * The helper only reads. Fan *writes* live in `fan-daemon.swift` behind a
 * privileged LaunchDaemon, because SMC writes return kIOReturnNotPrivileged for
 * a normal user.
 */

import Foundation

struct TemperatureKey {
    let name: String
    let type: String
    let size: UInt32
}

struct FanKeySet {
    let index: Int
    let actual: String
    let target: String
    let minimum: String
    let maximum: String
    let mode: String
}

struct Sampler {
    let smc: SMCConnection
    var temperatureKeys: [TemperatureKey] = []
    var fanKeys: [FanKeySet] = []

    static func open() -> Sampler? {
        guard let smc = SMCConnection.open() else { return nil }
        var sampler = Sampler(smc: smc)
        sampler.discoverTemperatureKeys()
        sampler.discoverFans()
        return sampler
    }

    /// Enumerate the key space once: every `T*` key whose value type we can
    /// decode is a temperature sensor on both Apple Silicon and Intel Macs.
    mutating func discoverTemperatureKeys() {
        guard let count = smc.keyCount(), count > 0, count <= 20_000 else { return }
        let decodable: Set<String> = ["flt ", "sp78", "fpe2"]
        var seen = Set<String>()
        for index in 0..<count {
            guard let key = smc.keyAt(index), let info = smc.keyInfo(key) else { continue }
            guard info.name.hasPrefix("T"), !seen.contains(info.name) else { continue }
            guard decodable.contains(info.type) else { continue }
            seen.insert(info.name)
            temperatureKeys.append(TemperatureKey(name: info.name, type: info.type, size: info.size))
        }
    }

    mutating func discoverFans() {
        guard let raw = smc.readKey("FNum"), let first = raw.bytes.first else { return }
        let count = Int(first)
        guard count > 0, count <= 8 else { return }
        for index in 0..<count {
            fanKeys.append(FanKeySet(
                index: index,
                actual: "F\(index)Ac",
                target: "F\(index)Tg",
                minimum: "F\(index)Mn",
                maximum: "F\(index)Mx",
                mode: "F\(index)Md"
            ))
        }
    }

    func fansValue() -> [[String: Any]] {
        return fanKeys.map { keys -> [String: Any] in
            var fan: [String: Any] = ["index": keys.index]
            if let raw = smc.readKey(keys.actual), let rpm = decodeFanValue(type: raw.type, bytes: raw.bytes) {
                fan["actualRpm"] = round2(rpm)
            }
            if let raw = smc.readKey(keys.target), let rpm = decodeFanValue(type: raw.type, bytes: raw.bytes) {
                fan["targetRpm"] = round2(rpm)
            }
            if let raw = smc.readKey(keys.minimum), let rpm = decodeFanValue(type: raw.type, bytes: raw.bytes) {
                fan["minRpm"] = round2(rpm)
            }
            if let raw = smc.readKey(keys.maximum), let rpm = decodeFanValue(type: raw.type, bytes: raw.bytes) {
                fan["maxRpm"] = round2(rpm)
            }
            if let raw = smc.readKey(keys.mode), let mode = decodeUInt8(type: raw.type, bytes: raw.bytes) {
                fan["mode"] = mode == 0 ? "auto" : (mode == 1 ? "forced" : "unknown")
            }
            return fan
        }
    }

    func temperaturesValue() -> [[String: Any]] {
        var readings: [[String: Any]] = []
        for key in temperatureKeys {
            guard let raw = smc.readKey(key.name) else { continue }
            guard let celsius = decodeTemperature(type: raw.type, bytes: raw.bytes) else { continue }
            readings.append(["key": key.name, "celsius": round2(celsius)])
        }
        return readings
    }

    func sample() -> [String: Any] {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        var payload: [String: Any] = ["at": now]
        if let raw = smc.readKey("FNum"), let first = raw.bytes.first {
            payload["fanCount"] = Int(first)
        } else {
            payload["fanCount"] = fanKeys.count
        }
        let fans = fansValue()
        if !fans.isEmpty { payload["fans"] = fans }
        let temperatures = temperaturesValue()
        if !temperatures.isEmpty { payload["temperatures"] = temperatures }
        return payload
    }
}

@main
struct StateSamplerMain {
    static func main() {
        var intervalMs = 1000
        var once = false
        var arguments = Array(CommandLine.arguments.dropFirst())
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--once" {
                once = true
            } else if argument == "--interval-ms", index + 1 < arguments.count {
                index += 1
                if let value = Int(arguments[index]), value >= 200, value <= 60000 {
                    intervalMs = value
                }
            }
            index += 1
        }

        guard let sampler = Sampler.open() else {
            FileHandle.standardError.write(Data("SMC_UNAVAILABLE\n".utf8))
            exit(3)
        }

        func emit(_ payload: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8) else {
                FileHandle.standardError.write(Data("SMC_JSON_FAILED\n".utf8))
                exit(4)
            }
            FileHandle.standardOutput.write(Data((text + "\n").utf8))
        }

        if once {
            emit(sampler.sample())
            exit(0)
        }

        while true {
            emit(sampler.sample())
            Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
        }
    }
}
