// ─── Document Text Extraction — Evidence Scan ──────────────────────────────
//
// Single dispatcher, extractDocumentText(entry), for the Folder-Based
// Keyword & Evidence Scan feature. `entry` is the { name, getFile } shape
// already produced by folderScanUtils.js (source-agnostic — local folder,
// GitHub, SharePoint, Google Drive all normalize to this same shape).
//
// Heavy libraries (pdfjs-dist, mammoth, jszip, tesseract.js) are
// dynamic-imported so they never bloat the initial page load — mirrors the
// existing `await import('docx')` convention already used in afrExport.js's
// downloadAFRWord().
//
// Never throws: any read/parse/OCR failure resolves to { error, status:
// 'ERROR', errorReason } so the caller can still emit a row for the file —
// every document must remain traceable, never silently dropped.
//
// Client-side only (this app has no backend — see aiService.js). This has
// two consequences worth calling out explicitly:
//   1. OCR via tesseract.js fetches its worker/core/English-traineddata
//      from a CDN (jsdelivr) by default on first use, so OCR requires
//      internet access at runtime; this is tesseract.js's standard
//      zero-config setup.
//   2. Legacy binary .doc / .ppt formats have no reliable pure-JS parser,
//      and this app has no server process to shell out to a CLI converter
//      (e.g. `libreoffice --headless --convert-to docx`) — there is no
//      backend at all, browser JS cannot invoke local executables. These
//      formats are therefore always reported as ERROR with a clear reason
//      rather than silently skipped or half-parsed; the same applies to
//      `pdftotext`/`pdffonts` for PDFs, where the pdfjs-dist text-layer
//      length check below is the client-side equivalent of `pdffonts`
//      ("does a real text layer exist, or is this scanned?").

import * as XLSX from 'xlsx'

const TABULAR_EXTS = ['xlsx', 'xls']
const IMAGE_EXTS = ['png', 'jpg', 'jpeg']
const PDF_EXT = 'pdf'
const DOCX_EXT = 'docx'
const DOC_EXT = 'doc'
const PPTX_EXT = 'pptx'
const PPT_EXT = 'ppt'

// Scanned/image-only PDFs have a near-empty text layer — this is the
// threshold below which we treat a PDF as needing OCR instead of trusting
// its (near-empty) extracted text layer. Client-side equivalent of running
// `pdffonts` to check for embedded text/fonts.
const SCANNED_PDF_AVG_CHARS_PER_PAGE = 40

function getExt(name) {
  return (name || '').split('.').pop().toLowerCase()
}

let sharedOcrWorkerPromise = null
async function getOcrWorker() {
  if (!sharedOcrWorkerPromise) {
    sharedOcrWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      return createWorker('eng')
    })()
  }
  return sharedOcrWorkerPromise
}

// Called once after a full scan run completes, to release the shared OCR
// worker rather than leaving it running indefinitely.
export async function terminateOcrWorker() {
  if (!sharedOcrWorkerPromise) return
  try {
    const worker = await sharedOcrWorkerPromise
    await worker.terminate()
  } catch (_) {
    // best-effort cleanup only
  } finally {
    sharedOcrWorkerPromise = null
  }
}

async function ocrImageSource(imageSource) {
  const worker = await getOcrWorker()
  const { data } = await worker.recognize(imageSource)
  return data.text || ''
}

// Reads EVERY sheet and EVERY row/column — no row cap, no sheet cap.
async function extractFromXlsx(file) {
  try {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array', cellDates: true })
    const parts = wb.SheetNames.map(sheetName => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: '' })
      return rows.map(row => row.join(' ')).join('\n')
    })
    return { text: parts.join('\n'), method: 'text-layer', ocrUsed: false, status: 'OK' }
  } catch (e) {
    return errorResult('File appears to be corrupted', e)
  }
}

// mammoth's raw-text extractor (lib/raw-text.js) recurses through every
// element's `.children`, and table/row/cell nodes carry `.children` too —
// so paragraph text inside docx tables is already included below, with no
// extra handling needed.
async function extractFromDocx(file) {
  try {
    const mammoth = await import('mammoth')
    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer })
    return { text: result.value || '', method: 'text-layer', ocrUsed: false, status: 'OK' }
  } catch (e) {
    return errorResult('File appears to be corrupted', e)
  }
}

// Legacy binary Word/PowerPoint formats. No pure-JS parser exists for either,
// and this app is client-side only with no backend to shell out to a CLI
// converter (e.g. LibreOffice headless) from — there is nowhere for a
// conversion step to run. No conversion is attempted; the file is reported
// as ERROR immediately, with detectedType/confidence set so the
// Classification tab and Excel export show it as a format-level rejection
// (not a content-classification failure — see documentClassificationEngine.js
// consumers of these fields).
const LEGACY_FORMAT_REASON = 'Legacy .doc/.ppt format not supported in browser. Please convert to .docx or .pptx before uploading.'

async function extractFromLegacyDoc() {
  return legacyFormatErrorResult()
}

async function extractFromLegacyPpt() {
  return legacyFormatErrorResult()
}

function legacyFormatErrorResult() {
  return {
    text: '', method: 'unsupported', ocrUsed: false, status: 'ERROR',
    error: LEGACY_FORMAT_REASON, errorReason: LEGACY_FORMAT_REASON,
    detectedType: 'Unsupported Format', confidence: 'N/A',
  }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
      return Number.isNaN(code) ? m : String.fromCodePoint(code)
    }
    return XML_ENTITIES[ent] ?? m
  })
}

// pptx is a zip of per-slide XML parts (ppt/slides/slideN.xml). Every text
// run on a slide — title placeholder or body — lives in an <a:t> element, so
// pulling every <a:t> off every slide, in slide-number order, captures both
// titles and body text without needing to distinguish placeholder types.
async function extractFromPptx(file) {
  try {
    const JSZip = (await import('jszip')).default
    const buf = await file.arrayBuffer()
    const zip = await JSZip.loadAsync(buf)

    const slideFiles = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)\.xml$/)[1], 10)
        const nb = parseInt(b.match(/slide(\d+)\.xml$/)[1], 10)
        return na - nb
      })

    if (slideFiles.length === 0) return errorResult('File appears to be corrupted')

    const slideTexts = []
    for (const slidePath of slideFiles) {
      const xml = await zip.files[slidePath].async('string')
      const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => decodeXmlEntities(m[1]))
      slideTexts.push(runs.join(' '))
    }

    return { text: slideTexts.join('\n'), method: 'text-layer', ocrUsed: false, status: 'OK' }
  } catch (e) {
    return errorResult('File appears to be corrupted', e)
  }
}

async function renderPdfPageToCanvas(page, scale = 2) {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const context = canvas.getContext('2d')
  await page.render({ canvasContext: context, viewport }).promise
  return canvas
}

async function extractFromPdf(file) {
  let pdf
  try {
    const pdfjsLib = await import('pdfjs-dist')
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

    const buf = await file.arrayBuffer()
    pdf = await pdfjsLib.getDocument({ data: buf }).promise
  } catch (e) {
    return errorResult('File appears to be corrupted', e)
  }

  try {
    const pageTexts = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      pageTexts.push(content.items.map(it => it.str).join(' '))
    }
    const textLayer = pageTexts.join('\n')
    const avgCharsPerPage = pdf.numPages ? textLayer.replace(/\s+/g, '').length / pdf.numPages : 0

    // A real text layer exists (equivalent to a non-empty `pdffonts`
    // result) — trust it, text-based PDF path.
    if (avgCharsPerPage >= SCANNED_PDF_AVG_CHARS_PER_PAGE) {
      return { text: textLayer, method: 'text-layer', ocrUsed: false, status: 'OK' }
    }

    // Sparse/empty text layer — treat as a scanned/image-only PDF and OCR
    // every page's rendered image (no page cap — the full document is run).
    const ocrTexts = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const canvas = await renderPdfPageToCanvas(page)
      const text = await ocrImageSource(canvas)
      ocrTexts.push(text)
    }
    const ocrText = ocrTexts.join('\n')
    if (!ocrText.trim()) return errorResult('OCR failed — no readable text found')

    return { text: ocrText, method: 'ocr', ocrUsed: true, status: 'OK' }
  } catch (e) {
    return errorResult('File appears to be corrupted', e)
  }
}

async function extractFromImage(file) {
  try {
    const text = await ocrImageSource(file)
    if (!text.trim()) return errorResult('OCR failed — no readable text found')
    return { text, method: 'ocr', ocrUsed: true, status: 'OK' }
  } catch (e) {
    return errorResult('OCR failed — no readable text found', e)
  }
}

function errorResult(errorReason, e) {
  const reason = e && e.message && !errorReason ? e.message : errorReason
  return { text: '', method: 'error', ocrUsed: false, status: 'ERROR', error: reason, errorReason: reason }
}

// Returns { text, method, ocrUsed, status, unsupported, error, errorReason,
// note }. `status` is 'OK' or 'ERROR' (added for the CMMI Audit Scan
// pipeline's classification/gap reporting — every file must be traceable,
// including files that fail to parse). `unsupported`/`error` are kept for
// backward compatibility with the existing Evidence Scan pipeline
// (evidenceScanEngine.js's buildDocumentRow). Never throws.
export async function extractDocumentText(entry) {
  const ext = getExt(entry.name)
  try {
    const file = await entry.getFile()

    if (TABULAR_EXTS.includes(ext)) return await extractFromXlsx(file)
    if (ext === DOCX_EXT) return await extractFromDocx(file)
    if (ext === DOC_EXT) return await extractFromLegacyDoc(file)
    if (ext === PPTX_EXT) return await extractFromPptx(file)
    if (ext === PPT_EXT) return await extractFromLegacyPpt(file)
    if (ext === PDF_EXT) return await extractFromPdf(file)
    if (IMAGE_EXTS.includes(ext)) return await extractFromImage(file)

    return { text: '', method: 'unsupported', ocrUsed: false, unsupported: true, status: 'ERROR', error: 'Unsupported file format', errorReason: 'Unsupported file format' }
  } catch (e) {
    return errorResult(e.message || 'Could not read or parse this file.', e)
  }
}

export { getExt, TABULAR_EXTS, IMAGE_EXTS, PDF_EXT, DOCX_EXT, DOC_EXT, PPTX_EXT, PPT_EXT }
