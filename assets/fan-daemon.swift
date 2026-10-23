/**
 * dsh-mac-tools — privileged fan helper.
 *
 * Runs as root under a LaunchDaemon installed by `src/fans.js` (the installer
 * runs through the standard macOS administrator dialog once). It owns a Unix
 * domain socket and accepts a tiny JSON-line protocol from the Host:
 *
 *   {"op":"ping"}                              -> {"ok":true,"protocol":1,...}
 *   {"op":"status"}                            -> forced fans
 *   {"op":"set","fan":0,"rpm":2500}            -> force one fan to a clamped RPM
 *   {"op":"auto","fan":0}                      -> give one fan back to the SMC
 *   {"op":"autoAll"}                           -> give every fan back to the SMC
 *
 * Safety properties:
 * - only the user recorded at install time (and root) may connect
 *   (`getpeereid`);
 * - the socket carries this fixed command set — no shell, no file access;
 * - targets are clamped to the fan's own SMC minimum / maximum;
 * - fans are restored to automatic when the client disconnects, when no
 *   command arrives for 12 s, and on SIGTERM/SIGINT, so a crashed Host can
 *   never leave the machine with a pinned fan.
 *
 * Build: swiftc -O smc-core.swift fan-daemon.swift -o fan-daemon
 */

import Foundation
import Darwin

let kFanProtocolVersion = 1
let kFanWatchdogSeconds: TimeInterval = 12
let kFanMaxLineBytes = 4096

// MARK: - options

struct DaemonOptions {
    var socketPath: String
    var ownerUID: uid_t
}

func parseOptions() -> DaemonOptions {
    var options = DaemonOptions(socketPath: "", ownerUID: getuid())
    var arguments = Array(CommandLine.arguments.dropFirst())
    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        if argument == "--socket", index + 1 < arguments.count {
            index += 1
            options.socketPath = arguments[index]
        } else if argument == "--owner-uid", index + 1 < arguments.count {
            index += 1
            if let value = UInt32(arguments[index]) {
                options.ownerUID = uid_t(value)
            }
        }
        index += 1
    }
    return options
}

func logLine(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write(Data("[fan-daemon \(stamp)] \(message)\n".utf8))
}

// MARK: - SMC fan control

struct FanWriter {
    let smc: SMCConnection
    var fanCount: Int = 0
    var littleEndian: Bool = true

    static func open() -> FanWriter? {
        guard let smc = SMCConnection.open() else { return nil }
        var writer = FanWriter(smc: smc)
        if let raw = smc.readKey("FNum"), let first = raw.bytes.first, first > 0, first <= 8 {
            writer.fanCount = Int(first)
        }
        writer.littleEndian = writer.detectEndianness()
        return writer
    }

    /// Decide the float byte order from the fan limits themselves: whichever
    /// interpretation lands in a plausible RPM range wins.
    func detectEndianness() -> Bool {
        for key in ["F0Mx", "F0Ac", "F0Mn"] {
            guard let raw = smc.readKey(key), raw.type == "flt " else { continue }
            let little = floatLE(raw.bytes)
            let big = floatBE(raw.bytes)
            let littleOK = little.map { plausible($0, 0, 20000) } ?? false
            let bigOK = big.map { plausible($0, 0, 20000) } ?? false
            if littleOK && !bigOK { return true }
            if bigOK && !littleOK { return false }
        }
        // Apple Silicon stores `flt ` values little-endian; Intel big-endian.
        #if arch(arm64)
        return true
        #else
        return false
        #endif
    }

    func limits(_ index: Int) -> (minimum: Double, maximum: Double)? {
        let minimumKey = "F\(index)Mn"
        let maximumKey = "F\(index)Mx"
        guard let minimumRaw = smc.readKey(minimumKey),
              let maximumRaw = smc.readKey(maximumKey),
              let minimum = decodeFanValue(type: minimumRaw.type, bytes: minimumRaw.bytes),
              let maximum = decodeFanValue(type: maximumRaw.type, bytes: maximumRaw.bytes),
              maximum > minimum else {
            return nil
        }
        return (minimum, maximum)
    }

    /// Force one fan to an RPM clamped to its SMC limits.
    func setFan(index: Int, requestedRpm: Double) -> (appliedRpm: Double, minimum: Double, maximum: Double)? {
        guard index >= 0, index < fanCount else { return nil }
        guard let limits = limits(index) else { return nil }
        let target = min(max(requestedRpm, limits.minimum), limits.maximum)

        // Mode first: 1 = forced, 0 = automatic. Without this the target alone
        // is ignored by the SMC.
        guard let modeRaw = smc.readKey("F\(index)Md") else { return nil }
        let modeWritten = smc.writeKey("F\(index)Md", type: modeRaw.type, size: modeRaw.size, bytes: [1])
        guard modeWritten else { return nil }

        guard let targetRaw = smc.readKey("F\(index)Tg") else { return nil }
        var valueBytes: [UInt8]
        switch targetRaw.type {
        case "flt ":
            valueBytes = encodeFloat(Float(target), littleEndian: littleEndian)
        case "fpe2":
            let fixed = UInt16(max(0, min(65535, target * 4)))
            valueBytes = littleEndian
                ? [UInt8(fixed & 0xff), UInt8((fixed >> 8) & 0xff)]
                : [UInt8((fixed >> 8) & 0xff), UInt8(fixed & 0xff)]
        default:
            return nil
        }
        guard smc.writeKey("F\(index)Tg", type: targetRaw.type, size: targetRaw.size, bytes: valueBytes) else {
            // Do not leave a fan forced with an unset target.
            _ = smc.writeKey("F\(index)Md", type: modeRaw.type, size: modeRaw.size, bytes: [0])
            return nil
        }
        return (target, limits.minimum, limits.maximum)
    }

    /// Give one fan back to the SMC's automatic control.
    @discardableResult
    func autoFan(index: Int) -> Bool {
        guard index >= 0, index < fanCount, let modeRaw = smc.readKey("F\(index)Md") else { return false }
        return smc.writeKey("F\(index)Md", type: modeRaw.type, size: modeRaw.size, bytes: [0])
    }
}

// MARK: - daemon

var gStop = false
var gClientFD: Int32 = -1

func installSignalHandlers() {
    signal(SIGTERM) { _ in gStop = true }
    signal(SIGINT) { _ in gStop = true }
    signal(SIGPIPE, SIG_IGN)
}

final class FanDaemon {
    let options: DaemonOptions
    var listener: Int32 = -1
    var writer: FanWriter?
    var forced: [Int: Double] = [:]
    var lastCommandAt = Date()

    init(options: DaemonOptions) {
        self.options = options
    }

    func run() {
        installSignalHandlers()
        if let opened = FanWriter.open() {
            writer = opened
            logLine("SMC ready, fans=\(opened.fanCount), littleEndian=\(opened.littleEndian)")
        } else {
            logLine("SMC unavailable; the daemon will answer with errors")
        }
        guard setupSocket() else { exit(2) }
        logLine("listening on \(options.socketPath), owner uid \(options.ownerUID)")
        while !gStop {
            var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 1000)
            if gStop { break }
            if ready > 0 {
                acceptClient()
            }
            checkWatchdog()
        }
        restoreAll()
        if listener >= 0 { close(listener) }
        logLine("stopped")
    }

    func setupSocket() -> Bool {
        guard !options.socketPath.isEmpty else {
            logLine("no --socket path")
            return false
        }
        var info = stat()
        if stat(options.socketPath, &info) == 0 {
            let kind = info.st_mode & S_IFMT
            if kind != S_IFSOCK {
                logLine("refusing to replace a non-socket at \(options.socketPath)")
                return false
            }
            unlink(options.socketPath)
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            logLine("socket() failed: \(errno)")
            return false
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(options.socketPath.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            logLine("socket path is too long")
            return false
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count + 1) { destination in
                for (index, byte) in pathBytes.enumerated() {
                    destination[index] = CChar(bitPattern: byte)
                }
                destination[pathBytes.count] = 0
            }
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                bind(fd, socketAddress, length)
            }
        }
        guard bound == 0 else {
            logLine("bind() failed: \(errno)")
            close(fd)
            return false
        }
        chmod(options.socketPath, 0o666)
        guard listen(fd, 4) == 0 else {
            logLine("listen() failed: \(errno)")
            close(fd)
            return false
        }
        listener = fd
        return true
    }

    func acceptClient() {
        let client = accept(listener, nil, nil)
        guard client >= 0 else { return }
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(client, &uid, &gid) == 0 else {
            logLine("getpeereid failed; closing connection")
            close(client)
            return
        }
        guard uid == options.ownerUID || uid == 0 else {
            logLine("refusing connection from uid \(uid)")
            close(client)
            return
        }
        logLine("client connected (uid \(uid))")
        serve(client: client)
        logLine("client disconnected")
    }

    func serve(client: Int32) {
        gClientFD = client
        var buffer = [UInt8]()
        var readBuffer = [UInt8](repeating: 0, count: 8192)
        while !gStop {
            var descriptor = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 1000)
            if gStop { break }
            if ready <= 0 {
                checkWatchdog()
                continue
            }
            let count = read(client, &readBuffer, readBuffer.count)
            if count <= 0 { break }
            buffer.append(contentsOf: readBuffer[0..<count])
            if buffer.count > 65536 { buffer.removeAll() }
            while let newline = buffer.firstIndex(of: 0x0a) {
                let lineBytes = Array(buffer[0..<newline])
                buffer.removeSubrange(0...newline)
                let line = String(bytes: lineBytes, encoding: .utf8) ?? ""
                if line.isEmpty { continue }
                let response = handle(line: line)
                writeResponse(response, to: client)
            }
        }
        gClientFD = -1
        restoreAll()
    }

    func writeResponse(_ response: [String: Any], to client: Int32) {
        guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) else { return }
        var payload = data
        payload.append(0x0a)
        payload.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(client, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
    }

    func handle(line: String) -> [String: Any] {
        guard let data = line.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data),
              let command = parsed as? [String: Any],
              let op = command["op"] as? String else {
            return ["ok": false, "error": "bad-request"]
        }
        lastCommandAt = Date()
        switch op {
        case "ping":
            return ["ok": true, "protocol": kFanProtocolVersion, "pid": Int(getpid())]
        case "status":
            let entries = forced.keys.sorted().map { fan -> [String: Any] in
                ["fan": fan, "rpm": forced[fan] ?? 0]
            }
            return ["ok": true, "forced": entries, "fanCount": writer?.fanCount ?? 0]
        case "set":
            guard let writer = writer else { return ["ok": false, "error": "smc-unavailable"] }
            guard let fan = intValue(command["fan"]), let rpm = doubleValue(command["rpm"]) else {
                return ["ok": false, "error": "bad-request"]
            }
            guard let applied = writer.setFan(index: fan, requestedRpm: rpm) else {
                return ["ok": false, "error": "smc-write-failed"]
            }
            forced[fan] = applied.appliedRpm
            return [
                "ok": true,
                "fan": fan,
                "rpm": applied.appliedRpm,
                "minRpm": applied.minimum,
                "maxRpm": applied.maximum,
            ]
        case "auto":
            guard let writer = writer else { return ["ok": false, "error": "smc-unavailable"] }
            guard let fan = intValue(command["fan"]) else { return ["ok": false, "error": "bad-request"] }
            let restored = writer.autoFan(index: fan)
            forced.removeValue(forKey: fan)
            return ["ok": true, "fan": fan, "restored": restored]
        case "autoAll":
            restoreAll()
            return ["ok": true, "restored": true]
        default:
            return ["ok": false, "error": "unknown-op"]
        }
    }

    func restoreAll() {
        guard let writer = writer else {
            forced.removeAll()
            return
        }
        for fan in forced.keys.sorted() {
            if !writer.autoFan(index: fan) {
                logLine("failed to restore fan \(fan) to automatic")
            }
        }
        if !forced.isEmpty { logLine("restored fans \(forced.keys.sorted()) to automatic") }
        forced.removeAll()
    }

    func checkWatchdog() {
        guard !forced.isEmpty else { return }
        guard Date().timeIntervalSince(lastCommandAt) > kFanWatchdogSeconds else { return }
        logLine("watchdog: no command for \(Int(kFanWatchdogSeconds))s, restoring automatic control")
        restoreAll()
    }

    func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }

    func doubleValue(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let string = value as? String { return Double(string) }
        return nil
    }
}

@main
struct FanDaemonMain {
    static func main() {
        let options = parseOptions()
        guard !options.socketPath.isEmpty else {
            logLine("usage: fan-daemon --socket <path> --owner-uid <uid>")
            exit(2)
        }
        FanDaemon(options: options).run()
    }
}
