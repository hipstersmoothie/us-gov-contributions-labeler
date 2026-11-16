// Read a scanned disclosure page: pick its orientation, OCR the words with
// their positions, find the table's ruling lines, and measure the ink inside
// every grid cell (an X mark shows up as a cell with more ink than its row).
//
//   swiftc -O analyze.swift -o analyze && ./analyze file.pdf [firstPage lastPage]
//
// Prints one JSON object per page. Coordinates are 0..1, origin top left.
// macOS only (PDFKit, Vision); runs entirely on this machine.
import AppKit
import Foundation
import PDFKit
import Vision

struct Word: Codable {
  let t: String; let x0, y0, x1, y1: Double; let c: Float
  /** For dates: every reading (page, 3x crop, 4x binarized crop); t is the majority. */
  var reads: [String]? = nil
}
/** Ink per column across the horizontal band of one date-like word. */
struct Band: Codable {
  let x0, x1, y0, y1: Double
  let ink: [Double]
  /**
   * Ink across the page in 300 bins, for measuring columns the line finder
   * missed. Pixel rows that are ruling lines are skipped, and so are pixel
   * columns dark through most of the band (a vertical rule, solid or dashed).
   */
  let profile: [Double]
}
struct Page: Codable {
  let file: String
  let page: Int
  let rotation: Int
  let words: [Word]
  let vlines: [Double]
  let hlines: [Double]
  /** ink[row][col]: share of dark pixels inside each cell, margins trimmed. */
  let ink: [[Double]]
  /** Rows defined by dates rather than ruling lines, which scans often lose. */
  let bands: [Band]
}

func render(_ page: PDFPage, longSide: CGFloat, rotation: Int) -> CGImage? {
  let b = page.bounds(for: .mediaBox)
  let scale = longSide / max(b.width, b.height)
  var w = Int(b.width * scale), h = Int(b.height * scale)
  if rotation % 180 != 0 { swap(&w, &h) }
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
  ctx.setFillColor(gray: 1, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.translateBy(x: CGFloat(w) / 2, y: CGFloat(h) / 2)
  ctx.rotate(by: -CGFloat(rotation) * .pi / 180)
  let (dw, dh) = rotation % 180 == 0 ? (CGFloat(w), CGFloat(h)) : (CGFloat(h), CGFloat(w))
  ctx.translateBy(x: -dw / 2, y: -dh / 2)
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -b.minX, y: -b.minY)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

func ocr(_ img: CGImage, fast: Bool) -> [Word] {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = fast ? .fast : .accurate
  req.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: img).perform([req])
  return (req.results ?? []).compactMap { o in
    guard let c = o.topCandidates(1).first else { return nil }
    let b = o.boundingBox
    return Word(t: c.string, x0: b.minX, y0: 1 - b.maxY, x1: b.maxX, y1: 1 - b.minY, c: c.confidence)
  }
}

/** Score an orientation by how much confident text Vision reads. */
func score(_ words: [Word]) -> Double {
  words.reduce(0) { $0 + Double($1.t.count) * Double($1.c) }
}

func pixels(_ img: CGImage) -> [UInt8] {
  var px = [UInt8](repeating: 255, count: img.width * img.height)
  let ctx = CGContext(data: &px, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width,
                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
  return px
}

/** Positions (0..1) of straight ruling lines: runs of dark pixels at least `minRun` of the page long. */
func lines(_ px: [UInt8], w: Int, h: Int, vertical: Bool, minRun: Double) -> [Double] {
  let n = vertical ? w : h, len = vertical ? h : w
  var hits: [Int] = []
  for i in 0..<n {
    var run = 0, best = 0
    for j in 0..<len {
      let v = vertical ? px[j * w + i] : px[i * w + j]
      if v < 140 { run += 1; best = max(best, run) } else if run > 0 {
        // Tolerate tiny gaps in scanned lines.
        run = (j + 1 < len && (vertical ? px[(j + 1) * w + i] : px[i * w + j + 1]) < 140) ? run : 0
      }
    }
    if Double(best) >= minRun * Double(len) { hits.append(i) }
  }
  // Merge neighbouring pixel columns into one line.
  var out: [Double] = []
  var start = -10, last = -10
  for i in hits {
    if i - last > 3 { if last >= 0 { out.append(Double(start + last) / 2 / Double(n)) }; start = i }
    last = i
  }
  if last >= 0 { out.append(Double(start + last) / 2 / Double(n)) }
  // The two edges of a printed checkbox read as lines too; keep one.
  var merged: [Double] = []
  for x in out {
    if let prev = merged.last, x - prev < 0.012 { merged[merged.count - 1] = (prev + x) / 2 } else { merged.append(x) }
  }
  return merged
}

func cellInk(_ px: [UInt8], w: Int, h: Int, xs: [Double], ys: [Double]) -> [[Double]] {
  guard xs.count > 1, ys.count > 1 else { return [] }
  var rows: [[Double]] = []
  for r in 0..<(ys.count - 1) {
    var row: [Double] = []
    for c in 0..<(xs.count - 1) {
      let x0 = xs[c] * Double(w), x1 = xs[c + 1] * Double(w), y0 = ys[r] * Double(h), y1 = ys[r + 1] * Double(h)
      // Trim 12% off each side so the ruling lines don't count. Printed box
      // outlines still do; the parser compares each cell with its column.
      let mx = (x1 - x0) * 0.12, my = (y1 - y0) * 0.12
      let ax = Int(x0 + mx), bx = Int(x1 - mx), ay = Int(y0 + my), by = Int(y1 - my)
      if bx <= ax || by <= ay { row.append(0); continue }
      row.append(darkShare(px, w: w, ax: ax, bx: bx, ay: ay, by: by))
    }
    rows.append(row)
  }
  return rows
}

/** Dark share of a rectangle, skipping pixel rows that are mostly dark: those are ruling lines, not marks. */
func darkShare(_ px: [UInt8], w: Int, ax: Int, bx: Int, ay: Int, by: Int) -> Double {
  var dark = 0, rows = 0
  for y in ay..<by {
    var n = 0
    for x in ax..<bx where px[y * w + x] < 140 { n += 1 }
    if Double(n) > 0.6 * Double(bx - ax) { continue }
    dark += n
    rows += 1
  }
  return rows == 0 ? 0 : Double(dark) / Double((bx - ax) * rows)
}

/** Ink across a band in `bins` slices, without ruling lines either way. */
func bandProfile(_ px: [UInt8], w: Int, h: Int, y0: Double, y1: Double, bins: Int = 300) -> [Double] {
  let ay = max(0, Int(y0 * Double(h))), by = min(h, Int(y1 * Double(h)))
  guard by > ay else { return Array(repeating: 0, count: bins) }
  // Rows that are mostly dark across the page are horizontal rules.
  let rows = (ay..<by).filter { y in
    var n = 0
    for x in 0..<w where px[y * w + x] < 140 { n += 1 }
    return Double(n) < 0.5 * Double(w)
  }
  guard !rows.isEmpty else { return Array(repeating: 0, count: bins) }
  var col = [Double](repeating: 0, count: w)
  for x in 0..<w {
    var n = 0
    for y in rows where px[y * w + x] < 140 { n += 1 }
    let f = Double(n) / Double(rows.count)
    col[x] = f > 0.55 ? 0 : f
  }
  return (0..<bins).map { b in
    let a = b * w / bins, z = max(a + 1, (b + 1) * w / bins)
    return col[a..<z].reduce(0, +) / Double(z - a)
  }
}

/** Ink per column within a horizontal band, columns trimmed like cells. */
func bandInk(_ px: [UInt8], w: Int, h: Int, xs: [Double], y0: Double, y1: Double) -> [Double] {
  guard xs.count > 1 else { return [] }
  let ay = max(0, Int(y0 * Double(h))), by = min(h, Int(y1 * Double(h)))
  return (0..<(xs.count - 1)).map { c in
    let x0 = xs[c] * Double(w), x1 = xs[c + 1] * Double(w), mx = (x1 - x0) * 0.12
    let ax = Int(x0 + mx), bx = Int(x1 - mx)
    if bx <= ax || by <= ay { return 0 }
    return darkShare(px, w: w, ax: ax, bx: bx, ay: ay, by: by)
  }
}

let dateRe = try! NSRegularExpression(pattern: "^[0-9Oo]{1,2}[/.-][0-9Oo]{1,2}[/.-][0-9]{2,4}")
func isDate(_ s: String) -> Bool { dateRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

/** Crop a word's box (padded), enlarge it 3x, optionally turn it 180°, and OCR it alone. */
func reread(_ img: CGImage, _ w: Word, flip: Bool, scale: Int = 3, binarize: Bool = false) -> String? {
  let W = Double(img.width), H = Double(img.height)
  let padX = (w.x1 - w.x0) * 0.15, padY = (w.y1 - w.y0) * 0.5
  let rect = CGRect(x: max(0, (w.x0 - padX) * W), y: max(0, (w.y0 - padY) * H),
                    width: min(W, (w.x1 - w.x0 + 2 * padX) * W), height: min(H, (w.y1 - w.y0 + 2 * padY) * H)).integral
  guard let crop = img.cropping(to: rect) else { return nil }
  let sw = crop.width * scale, sh = crop.height * scale
  guard let ctx = CGContext(data: nil, width: sw, height: sh, bitsPerComponent: 8, bytesPerRow: sw,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
  ctx.interpolationQuality = .high
  if flip { ctx.translateBy(x: CGFloat(sw), y: CGFloat(sh)); ctx.rotate(by: .pi) }
  ctx.draw(crop, in: CGRect(x: 0, y: 0, width: sw, height: sh))
  if binarize, let data = ctx.data {
    let px = data.bindMemory(to: UInt8.self, capacity: sw * sh)
    for i in 0..<(sw * sh) { px[i] = px[i] < 150 ? 0 : 255 }
  }
  guard let big = ctx.makeImage() else { return nil }
  return ocr(big, fast: false).map { $0.t }.joined(separator: " ")
}

/**
 * Dates decide which rows exist, so read every date-shaped word again on its
 * own: Vision sometimes reads a date upside down ("9ZOZ/S/E" for 3/5/2026)
 * or blurs 05 and 06 on the full page.
 */
func fixDates(_ img: CGImage, _ words: [Word]) -> [Word] {
  words.map { w in
    let t = w.t
    // Slashes or dashes (08-21-2025, upside down "SZOZ-TZ-80").
    let shape = (t.contains("/") || t.filter { $0 == "-" }.count == 2) && t.filter { "0123456789ZSEOTLl".contains($0) }.count >= 4
    guard shape else { return w }
    for flip in [false, true] {
      guard let r = reread(img, w, flip: flip), isDate(r) else { continue }
      // Two more readings; the majority wins, and the parser flags any disagreement.
      let reads = [r, isDate(t) && !flip ? t : nil, reread(img, w, flip: flip, scale: 4, binarize: true)]
        .compactMap { $0 }.filter { isDate($0) }
      let key = { (s: String) in String(s.split(separator: " ").first ?? "") }
      let counts = Dictionary(grouping: reads, by: key).mapValues { $0.count }
      let winner = counts.max { $0.value < $1.value || ($0.value == $1.value && $0.key != key(r)) }?.key ?? key(r)
      var out = Word(t: reads.first { key($0) == winner } ?? r, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, c: w.c)
      out.reads = reads
      return out
    }
    return w
  }
}

/** OCR one region of the page on its own, enlarged, with boxes mapped back to page coordinates. */
func ocrRegion(_ img: CGImage, x0: Double, y0: Double, x1: Double, y1: Double, scale: Int = 3) -> [Word] {
  let W = Double(img.width), H = Double(img.height)
  let rect = CGRect(x: x0 * W, y: y0 * H, width: (x1 - x0) * W, height: (y1 - y0) * H).integral
  guard let crop = img.cropping(to: rect) else { return [] }
  let sw = crop.width * scale, sh = crop.height * scale
  guard let ctx = CGContext(data: nil, width: sw, height: sh, bitsPerComponent: 8, bytesPerRow: sw,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return [] }
  ctx.interpolationQuality = .high
  ctx.draw(crop, in: CGRect(x: 0, y: 0, width: sw, height: sh))
  guard let big = ctx.makeImage() else { return [] }
  let fx = Double(rect.minX) / W, fy = Double(rect.minY) / H, fw = Double(rect.width) / W, fh = Double(rect.height) / H
  return ocr(big, fast: false).map { w in
    Word(t: w.t, x0: fx + w.x0 * fw, y0: fy + w.y0 * fh, x1: fx + w.x1 * fw, y1: fy + w.y1 * fh, c: w.c)
  }
}

/**
 * On a busy page Vision skips some dates outright (bold type, mostly), and a
 * row without a date doesn't exist for the parser. Read each column that
 * holds dates again as a strip of its own, and add the dates it finds that
 * the page read missed.
 */
func findMissedDates(_ img: CGImage, _ words: [Word], xs: [Double], ys: [Double]) -> [Word] {
  let dates = words.filter { isDate($0.t) }
  guard xs.count > 1, !dates.isEmpty else { return [] }
  var added: [Word] = []
  for c in 0..<(xs.count - 1) {
    let inCol = dates.filter { ($0.x0 + $0.x1) / 2 >= xs[c] && ($0.x0 + $0.x1) / 2 < xs[c + 1] }
    // A date column (narrow), not a name column that happens to hold a date.
    guard !inCol.isEmpty, xs[c + 1] - xs[c] < 0.15 else { continue }
    // The whole column: the dates found may all sit at the bottom. Its header
    // ("MM/DD/YY") isn't a date, and the printed example row is skipped later.
    let top = 0.0
    let strip = ocrRegion(img, x0: xs[c], y0: top, x1: xs[c + 1], y1: 1)
    var found = inCol
    for w in strip where isDate(w.t) {
      let mid = (w.y0 + w.y1) / 2
      if found.contains(where: { mid > $0.y0 && mid < $0.y1 }) { continue }
      added.append(w)
      found.append(w)
    }
    // Still missing: each ruled row, one cell at a time.
    for r in 0..<max(0, ys.count - 1) where ys[r] >= top && ys[r + 1] - ys[r] < 0.08 {
      if found.contains(where: { ($0.y0 + $0.y1) / 2 > ys[r] && ($0.y0 + $0.y1) / 2 < ys[r + 1] }) { continue }
      for w in ocrRegion(img, x0: xs[c], y0: ys[r], x1: xs[c + 1], y1: ys[r + 1], scale: 4) where isDate(w.t) {
        added.append(w)
        found.append(w)
      }
    }
  }
  return added
}

/**
 * Vision reads text running up or down the page too, so a sideways page can
 * score well upright. Its words then come back as boxes taller than wide.
 */
func sideways(_ words: [Word]) -> Bool {
  let long = words.filter { $0.t.count >= 4 }
  guard long.count >= 8 else { return false }
  return long.filter { ($0.y1 - $0.y0) > ($0.x1 - $0.x0) * 1.5 }.count > long.count / 2
}

let args = CommandLine.arguments
guard args.count >= 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { exit(1) }
let first = args.count > 2 ? Int(args[2])! : 0
let last = args.count > 3 ? min(Int(args[3])!, doc.pageCount - 1) : doc.pageCount - 1
let enc = JSONEncoder()
for p in first...last {
  guard let page = doc.page(at: p) else { continue }
  // Orientation: the one where Vision reads the most text, on a small render.
  // Upside down (180) has to read clearly better: on noisy scans it can
  // score a little higher than the right way up on noise alone.
  var scores: [Int: Double] = [:]
  for rot in [0, 90, 270, 180] {
    guard let small = render(page, longSide: 1100, rotation: rot) else { continue }
    scores[rot] = score(ocr(small, fast: true))
    if rot == 0 && scores[0]! > 400 { break }
  }
  var best = (0, scores[0] ?? 0)
  for rot in [90, 270] where (scores[rot] ?? 0) > best.1 { best = (rot, scores[rot]!) }
  if (scores[180] ?? 0) > best.1 * 1.5 { best = (180, scores[180]!) }
  guard var img = render(page, longSide: 2600, rotation: best.0) else { continue }
  var words = ocr(img, fast: false)
  if sideways(words) {
    // Turn it a quarter either way and keep the turn whose text reads across.
    var turned: (Int, Double)? = nil
    for rot in [(best.0 + 90) % 360, (best.0 + 270) % 360] {
      // Larger and slower than the first pass: small type turned reads as nothing at 1100 px.
      guard let small = render(page, longSide: 1800, rotation: rot) else { continue }
      let ws = ocr(small, fast: false)
      if ProcessInfo.processInfo.environment["DEBUG_SCAN"] != nil {
        FileHandle.standardError.write("turn \(rot): \(ws.count) words, sideways \(sideways(ws)), score \(score(ws))\n".data(using: .utf8)!)
      }
      if !sideways(ws), score(ws) > (turned?.1 ?? 0) { turned = (rot, score(ws)) }
    }
    if let t = turned, let big = render(page, longSide: 2600, rotation: t.0) {
      best = t
      img = big
      words = ocr(img, fast: false)
    }
  }
  words = fixDates(img, words)
  // Vision reads upside-down text too, so check the layout: owner tags
  // (SP/DC/JT) belong on the left, dollar ranges to the right of the dates.
  let meanX = { (ws: [Word]) in ws.isEmpty ? 0.5 : ws.map { ($0.x0 + $0.x1) / 2 }.reduce(0, +) / Double(ws.count) }
  let owners = words.filter { ["SP", "DC", "JT"].contains($0.t.trimmingCharacters(in: .whitespaces)) }
  let dates = words.filter { isDate($0.t) }
  let dollars = words.filter { $0.t.hasPrefix("$") }
  if (owners.count >= 3 && meanX(owners) > 0.6) || (dollars.count >= 3 && dates.count >= 2 && meanX(dollars) < meanX(dates) - 0.1),
     let flipped = render(page, longSide: 2600, rotation: (best.0 + 180) % 360) {
    best.0 = (best.0 + 180) % 360
    img = flipped
    words = fixDates(img, ocr(img, fast: false))
  }
  let px = pixels(img)
  let v = lines(px, w: img.width, h: img.height, vertical: true, minRun: 0.12)
  let hz = lines(px, w: img.width, h: img.height, vertical: false, minRun: 0.25)
  // Dates found only in the column strips are read again like the rest.
  words += fixDates(img, findMissedDates(img, words, xs: v, ys: hz))
  let bands = words.filter { isDate($0.t) }.map { d -> Band in
    // The band is the date's line, padded by a third of its height.
    let pad = (d.y1 - d.y0) * 0.35
    return Band(x0: d.x0, x1: d.x1, y0: d.y0 - pad, y1: d.y1 + pad,
                ink: bandInk(px, w: img.width, h: img.height, xs: v, y0: d.y0 - pad, y1: d.y1 + pad),
                profile: bandProfile(px, w: img.width, h: img.height, y0: d.y0 - pad, y1: d.y1 + pad))
  }
  let out = Page(file: URL(fileURLWithPath: args[1]).lastPathComponent, page: p, rotation: best.0, words: words,
                 vlines: v, hlines: hz, ink: cellInk(px, w: img.width, h: img.height, xs: v, ys: hz), bands: bands)
  print(String(data: try! enc.encode(out), encoding: .utf8)!)
  fflush(stdout)
}
