// Render one PDF page to PNG at a rotation, for the second reader.
//
//   swiftc -O render.swift -o render && ./render file.pdf page rotation longSide out.png
import AppKit
import Foundation
import PDFKit

let a = CommandLine.arguments
guard a.count == 6, let doc = PDFDocument(url: URL(fileURLWithPath: a[1])), let page = doc.page(at: Int(a[2])!) else { exit(1) }
let rotation = Int(a[3])!, longSide = CGFloat(Double(a[4])!)
let b = page.bounds(for: .mediaBox)
let scale = longSide / max(b.width, b.height)
var w = Int(b.width * scale), h = Int(b.height * scale)
if rotation % 180 != 0 { swap(&w, &h) }
let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
ctx.setFillColor(gray: 1, alpha: 1)
ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
ctx.translateBy(x: CGFloat(w) / 2, y: CGFloat(h) / 2)
ctx.rotate(by: -CGFloat(rotation) * .pi / 180)
let (dw, dh) = rotation % 180 == 0 ? (CGFloat(w), CGFloat(h)) : (CGFloat(h), CGFloat(w))
ctx.translateBy(x: -dw / 2, y: -dh / 2)
ctx.scaleBy(x: scale, y: scale)
ctx.translateBy(x: -b.minX, y: -b.minY)
page.draw(with: .mediaBox, to: ctx)
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[5]))
