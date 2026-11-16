// OCR scanned travel filings with macOS Vision: one JSON object per page, its
// lines with their boxes (0–1, origin top left) and Vision's confidence.
//
//   swiftc -O ocr.swift -o .cache/travel/ocr
//   .cache/travel/ocr [--size=2200] file.pdf 1,2,3   pages of a PDF (1-based)
//   .cache/travel/ocr a.png b.png         page images
import AppKit
import Foundation
import PDFKit
import Vision

// The page as displayed (rotation included), white behind it.
func render(_ page: PDFPage, longSide: CGFloat) -> CGImage? {
  let b = page.bounds(for: .mediaBox)
  let rotated = ((page.rotation % 360) + 360) % 180 != 0
  let (pw, ph) = rotated ? (b.height, b.width) : (b.width, b.height)
  let scale = longSide / max(pw, ph)
  let thumb = page.thumbnail(of: NSSize(width: pw * scale, height: ph * scale), for: .mediaBox)
  var rect = NSRect(origin: .zero, size: thumb.size)
  return thumb.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func ocr(_ img: CGImage) -> [[String: Any]] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
  return (req.results ?? []).compactMap { o in
    guard let t = o.topCandidates(1).first else { return nil }
    let b = o.boundingBox
    return ["s": t.string, "c": t.confidence, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height]
  }
}

var args = Array(CommandLine.arguments.dropFirst())
// --size=N renders PDF pages N pixels on the long side (default 2200).
var longSide: CGFloat = 2200
if let i = args.firstIndex(where: { $0.hasPrefix("--size=") }) {
  longSide = CGFloat(Double(args[i].dropFirst(7))!)
  args.remove(at: i)
}
var out: [[String: Any]] = []
if let first = args.first, first.lowercased().hasSuffix(".pdf") {
  guard let doc = PDFDocument(url: URL(fileURLWithPath: first)) else { exit(1) }
  let pages = args.count > 1 ? args[1].split(separator: ",").compactMap { Int($0) } : Array(1...doc.pageCount)
  for p in pages where p >= 1 && p <= doc.pageCount {
    guard let page = doc.page(at: p - 1), let img = render(page, longSide: longSide) else { continue }
    out.append(["page": p, "lines": ocr(img)])
  }
} else {
  for (i, file) in args.enumerated() {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
    out.append(["page": i + 1, "lines": ocr(img)])
  }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
