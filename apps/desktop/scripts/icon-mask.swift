import AppKit
import QuartzCore

// Use Apple's continuous CALayer curve for both the web mask and the packaged icon.
let output = CommandLine.arguments[1]
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!.cgContext
let layer = CALayer()
layer.frame = CGRect(x: 0, y: 0, width: size, height: size)
layer.backgroundColor = NSColor.white.cgColor
layer.cornerRadius = 224
layer.cornerCurve = .continuous
layer.masksToBounds = true
if CommandLine.arguments.count > 2 {
    let image = NSImage(contentsOfFile: CommandLine.arguments[2])!
    layer.contents = image.cgImage(forProposedRect: nil, context: nil, hints: nil)!
    layer.contentsGravity = .resize
}
layer.render(in: context)
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
