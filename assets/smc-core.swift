/**
 * dsh-mac-tools — shared SMC transport.
 *
 * Compiled together with `state.swift` (the sampling helper) and
 * `fan-daemon.swift` (the privileged fan writer): declaration-only file, no
 * top-level code, so both binaries share one implementation of the 80-byte
 * `SMCKeyData_t` transport and its value decoders.
 *
 * Layout notes:
 * - The 80-byte struct is addressed through a raw byte buffer; a Swift struct
 *   would omit the trailing C padding (76 vs 80 bytes) and the kernel rejects
 *   the call.
 * - Struct fields are host-endian; SMC *values* are little-endian for `flt `
 *   on Apple Silicon and big-endian elsewhere, so float decoding tries both
 *   and keeps the plausible one.
 */

import Foundation
import IOKit

let kSMCPath = "AppleSMC"
let kSMCUserClientOpen: UInt32 = 0
let kSMCCallSelector: UInt32 = 2

let kSMCReadBytes: UInt8 = 5
let kSMCWriteBytes: UInt8 = 6
let kSMCReadIndex: UInt8 = 8
let kSMCReadKeyInfo: UInt8 = 9

let kSMCKeyDataSize = 80
let kSMCKeyInfoOffset = 28
let kSMCData8Offset = 42
let kSMCData32Offset = 44
let kSMCBytesOffset = 48

func smcFourCC(_ text: String) -> UInt32 {
    let bytes = Array(text.utf8)
    var value: UInt32 = 0
    for index in 0..<4 {
        value = (value << 8) | UInt32(index < bytes.count ? bytes[index] : 0x20)
    }
    return value
}

func smcKeyName(_ key: UInt32) -> String {
    let chars: [UInt8] = [
        UInt8((key >> 24) & 0xff),
        UInt8((key >> 16) & 0xff),
        UInt8((key >> 8) & 0xff),
        UInt8(key & 0xff),
    ]
    return String(bytes: chars, encoding: .ascii) ?? "????"
}

func smcTypeName(_ type: UInt32) -> String {
    let chars: [UInt8] = [
        UInt8((type >> 24) & 0xff),
        UInt8((type >> 16) & 0xff),
        UInt8((type >> 8) & 0xff),
        UInt8(type & 0xff),
    ]
    return String(bytes: chars, encoding: .ascii) ?? "????"
}

func readU32LE(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    return UInt32(bytes[offset])
        | (UInt32(bytes[offset + 1]) << 8)
        | (UInt32(bytes[offset + 2]) << 16)
        | (UInt32(bytes[offset + 3]) << 24)
}

func readU32BE(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    return (UInt32(bytes[offset]) << 24)
        | (UInt32(bytes[offset + 1]) << 16)
        | (UInt32(bytes[offset + 2]) << 8)
        | UInt32(bytes[offset + 3])
}

func writeU32LE(_ bytes: inout [UInt8], _ offset: Int, _ value: UInt32) {
    bytes[offset] = UInt8(value & 0xff)
    bytes[offset + 1] = UInt8((value >> 8) & 0xff)
    bytes[offset + 2] = UInt8((value >> 16) & 0xff)
    bytes[offset + 3] = UInt8((value >> 24) & 0xff)
}

/// One open user client on the SMC service.
struct SMCConnection {
    let connection: io_connect_t
    let service: io_service_t

    static func open() -> SMCConnection? {
        guard let matching = IOServiceMatching(kSMCPath) else { return nil }
        let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
        guard service != 0 else { return nil }
        var connection: io_connect_t = 0
        let result = IOServiceOpen(service, mach_task_self_, kSMCUserClientOpen, &connection)
        guard result == KERN_SUCCESS else {
            IOObjectRelease(service)
            return nil
        }
        return SMCConnection(connection: connection, service: service)
    }

    func close() {
        IOServiceClose(connection)
        IOObjectRelease(service)
    }

    /// One raw SMC struct call (selector 2).
    func call(_ input: [UInt8]) -> [UInt8]? {
        var output = [UInt8](repeating: 0, count: kSMCKeyDataSize)
        var outputSize = kSMCKeyDataSize
        let result = input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> kern_return_t in
            output.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) -> kern_return_t in
                IOConnectCallStructMethod(
                    connection,
                    kSMCCallSelector,
                    raw.baseAddress,
                    kSMCKeyDataSize,
                    out.baseAddress,
                    &outputSize
                )
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return output
    }

    /// Read one key's metadata and value bytes.
    func readKey(_ name: String) -> (type: String, size: UInt32, bytes: [UInt8])? {
        let key = smcFourCC(name)
        var infoInput = [UInt8](repeating: 0, count: kSMCKeyDataSize)
        writeU32LE(&infoInput, 0, key)
        infoInput[kSMCData8Offset] = kSMCReadKeyInfo
        guard let infoOutput = call(infoInput) else { return nil }
        let dataSize = readU32LE(infoOutput, kSMCKeyInfoOffset)
        let dataType = readU32LE(infoOutput, kSMCKeyInfoOffset + 4)
        guard dataSize > 0, dataSize <= 32 else { return nil }

        var valueInput = [UInt8](repeating: 0, count: kSMCKeyDataSize)
        writeU32LE(&valueInput, 0, key)
        writeU32LE(&valueInput, kSMCKeyInfoOffset, dataSize)
        valueInput[kSMCData8Offset] = kSMCReadBytes
        guard let valueOutput = call(valueInput) else { return nil }
        return (smcTypeName(dataType), dataSize, Array(valueOutput[kSMCBytesOffset..<(kSMCBytesOffset + Int(dataSize))]))
    }

    /// Write one key's value bytes. Requires root; returns false on refusal.
    @discardableResult
    func writeKey(_ name: String, type: String, size: UInt32, bytes: [UInt8]) -> Bool {
        guard bytes.count == Int(size) else { return false }
        var input = [UInt8](repeating: 0, count: kSMCKeyDataSize)
        writeU32LE(&input, 0, smcFourCC(name))
        writeU32LE(&input, kSMCKeyInfoOffset, size)
        input[kSMCData8Offset] = kSMCWriteBytes
        for index in 0..<min(Int(size), 32) {
            input[kSMCBytesOffset + index] = bytes[index]
        }
        guard let output = call(input) else { return false }
        return output[40] == 0
    }

    /// Number of keys in the SMC key space (`#KEY`), or nil.
    ///
    /// Integer SMC values are big-endian (unlike this machine's `flt ` values,
    /// which are little-endian), so `#KEY` is decoded explicitly.
    func keyCount() -> UInt32? {
        guard let raw = readKey("#KEY"), raw.size == 4 else { return nil }
        return readU32BE(raw.bytes, 0)
    }

    /// The key name at an index in the SMC key space.
    func keyAt(_ index: UInt32) -> UInt32? {
        var input = [UInt8](repeating: 0, count: kSMCKeyDataSize)
        input[kSMCData8Offset] = kSMCReadIndex
        writeU32LE(&input, kSMCData32Offset, index)
        guard let output = call(input) else { return nil }
        return readU32LE(output, 0)
    }

    /// Read the metadata for one key without reading its value.
    func keyInfo(_ key: UInt32) -> (name: String, type: String, size: UInt32)? {
        var input = [UInt8](repeating: 0, count: kSMCKeyDataSize)
        writeU32LE(&input, 0, key)
        input[kSMCData8Offset] = kSMCReadKeyInfo
        guard let output = call(input) else { return nil }
        let size = readU32LE(output, kSMCKeyInfoOffset)
        let type = smcTypeName(readU32LE(output, kSMCKeyInfoOffset + 4))
        return (smcKeyName(key), type, size)
    }
}

// MARK: - Value decoding

func plausible(_ value: Double, _ minimum: Double, _ maximum: Double) -> Bool {
    return value.isFinite && value >= minimum && value <= maximum
}

/// Decode a little-endian IEEE-754 float (Apple Silicon SMC byte order).
func floatLE(_ bytes: [UInt8]) -> Double? {
    guard bytes.count >= 4 else { return nil }
    let bits = UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24)
    return Double(Float(bitPattern: bits))
}

/// Decode a big-endian IEEE-754 float (Intel SMC byte order).
func floatBE(_ bytes: [UInt8]) -> Double? {
    guard bytes.count >= 4 else { return nil }
    let bits = (UInt32(bytes[0]) << 24) | (UInt32(bytes[1]) << 16) | (UInt32(bytes[2]) << 8) | UInt32(bytes[3])
    return Double(Float(bitPattern: bits))
}

func fixedPoint(_ bytes: [UInt8], _ littleEndian: Bool, divisor: Double) -> Double? {
    guard bytes.count >= 2 else { return nil }
    let raw16: UInt16 = littleEndian
        ? UInt16(bytes[0]) | (UInt16(bytes[1]) << 8)
        : (UInt16(bytes[0]) << 8) | UInt16(bytes[1])
    return Double(raw16) / divisor
}

/// Encode a float in the byte order the SMC uses on this machine.
func encodeFloat(_ value: Float, littleEndian: Bool) -> [UInt8] {
    let bits = value.bitPattern
    let bigEndianBytes: [UInt8] = [
        UInt8((bits >> 24) & 0xff),
        UInt8((bits >> 16) & 0xff),
        UInt8((bits >> 8) & 0xff),
        UInt8(bits & 0xff),
    ]
    return littleEndian ? bigEndianBytes.reversed() : bigEndianBytes
}

/// Decode a temperature-like value, keeping whichever byte order is plausible.
func decodeTemperature(type: String, bytes: [UInt8]) -> Double? {
    switch type {
    case "flt ":
        for candidate in [floatLE(bytes), floatBE(bytes)] {
            if let value = candidate, plausible(value, -40, 200) { return value }
        }
        return nil
    case "sp78":
        // Signed 7.8 fixed point: -40…200 °C, both byte orders.
        for littleEndian in [true, false] {
            if let value = fixedPoint(bytes, littleEndian, divisor: 256) {
                let signed = value > 127 ? value - 256 : value
                if plausible(signed, -40, 200) { return signed }
            }
        }
        return nil
    case "fpe2":
        for littleEndian in [true, false] {
            if let value = fixedPoint(bytes, littleEndian, divisor: 4), plausible(value, -40, 200) {
                return value
            }
        }
        return nil
    default:
        return nil
    }
}

/// Decode an RPM-like value, keeping whichever byte order is plausible.
func decodeFanValue(type: String, bytes: [UInt8]) -> Double? {
    switch type {
    case "flt ":
        for candidate in [floatLE(bytes), floatBE(bytes)] {
            if let value = candidate, plausible(value, -1, 20000) { return value }
        }
        return nil
    case "fpe2":
        for littleEndian in [true, false] {
            if let value = fixedPoint(bytes, littleEndian, divisor: 4), plausible(value, -1, 20000) {
                return value
            }
        }
        return nil
    case "sp78":
        for littleEndian in [true, false] {
            if let value = fixedPoint(bytes, littleEndian, divisor: 256) {
                let signed = value > 127 ? value - 256 : value
                if plausible(signed, -1, 20000) { return signed }
            }
        }
        return nil
    case "ui16":
        for littleEndian in [true, false] {
            if let value = fixedPoint(bytes, littleEndian, divisor: 1), plausible(value, -1, 20000) {
                return value
            }
        }
        return nil
    case "ui8 ", "ui8":
        guard let first = bytes.first else { return nil }
        let value = Double(first)
        return plausible(value, -1, 20000) ? value : nil
    default:
        return nil
    }
}

func decodeUInt8(type: String, bytes: [UInt8]) -> UInt8? {
    guard let first = bytes.first else { return nil }
    return first
}

func round2(_ value: Double) -> Double {
    return (value * 100).rounded() / 100
}
