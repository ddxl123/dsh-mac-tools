// dsh-mac-tools — QR-code helper.
//
// A one-shot Swift program that renders a text payload (the phone-transfer
// session URL) as a QR code and prints it as base64 PNG on stdout. The plugin
// compiles this file once with `swiftc`, caches the binary by source hash and
// runs it whenever a transfer session starts (see src/transfer-qr.js). Usage:
//
//     qrcode <text> <size>
//
// `<size>` is the PNG edge length in pixels. The QR code uses CoreImage's
// built-in generator with M-level error correction, is scaled with nearest
// neighbour interpolation onto a white background (so phone cameras and
// `sips`/Preview see a normal opaque image) and written as PNG. On success the
// process prints one line of base64 to stdout and exits 0; on failure it writes
// the reason to stderr and exits non-zero. Missing arguments exit 2.

import AppKit
import CoreImage
import Foundation

/// Print a diagnostic to stderr and exit non-zero.
func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("ERROR \(message)\n".utf8))
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    fail("usage: qrcode <text> <size>", code: 2)
}

let text = arguments[1]
guard !text.isEmpty else {
    fail("the text is empty", code: 2)
}
guard let size = Int(arguments[2]), size > 0, size <= 4096 else {
    fail("size must be an integer between 1 and 4096", code: 2)
}

guard let message = text.data(using: .utf8) else {
    fail("the text is not valid UTF-8")
}
guard let generator = CIFilter(name: "CIQRCodeGenerator") else {
    fail("CIQRCodeGenerator is unavailable")
}
generator.setValue(message, forKey: "inputMessage")
generator.setValue("M", forKey: "inputCorrectionLevel")
guard let qrImage = generator.outputImage, !qrImage.extent.isEmpty else {
    fail("CoreImage produced no QR code")
}

// Rasterize the generator's 1:1 output first, then scale it with nearest
// neighbour sampling so the modules stay crisp at the requested pixel size.
let ciContext = CIContext()
guard let nativeImage = ciContext.createCGImage(qrImage, from: qrImage.extent) else {
    fail("could not rasterize the QR code")
}
let bytesPerRow = 0
guard let bitmapContext = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fail("could not create the QR bitmap context")
}
// The generator leaves the light modules transparent; paint them white.
bitmapContext.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
bitmapContext.fill(CGRect(x: 0, y: 0, width: size, height: size))
bitmapContext.interpolationQuality = .none
// The generator's output is one pixel per module plus a 1-pixel border. Scale
// it by a whole number of pixels per module and centre it, so every module is
// exactly the same size and the code keeps the 4-module quiet zone the QR
// specification requires (a nearest-neighbour draw at an arbitrary ratio makes
// some modules one pixel wider than others and leaves almost no margin).
let quietModulesPerSide = 4
let integerScale = size / (nativeImage.width + 2 * quietModulesPerSide)
if integerScale >= 1 {
    let drawnSize = nativeImage.width * integerScale
    let offset = (size - drawnSize) / 2
    bitmapContext.draw(nativeImage, in: CGRect(x: offset, y: offset, width: drawnSize, height: drawnSize))
} else {
    // Too small for an integer scale: fill the whole frame, quiet zone first.
    bitmapContext.draw(nativeImage, in: CGRect(x: 0, y: 0, width: size, height: size))
}
guard let scaledImage = bitmapContext.makeImage() else {
    fail("could not scale the QR code")
}

let representation = NSBitmapImageRep(cgImage: scaledImage)
representation.size = NSSize(width: size, height: size)
guard let png = representation.representation(using: .png, properties: [:]) else {
    fail("could not encode the QR code as PNG")
}

FileHandle.standardOutput.write(Data(png.base64EncodedString().utf8))
FileHandle.standardOutput.write(Data("\n".utf8))
exit(0)
