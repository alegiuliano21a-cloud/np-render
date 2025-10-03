import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdfParse from 'pdf-parse';

// Local OCR stack
import { createCanvas } from 'canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import Tesseract from 'tesseract.js';

// ---- ENV
const PORT = parseInt(process.env.PORT || '8787', 10);
const DEBUG = (process.env.DEBUG_LOG || '0') !== '0';
const OCR_ENABLE = (process.env.OCR_ENABLE ?? '1') !== '0';
const OCR_LANGS = process.env.OCR_LANGS || 'eng';

// CORS allowlist
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!ALLOWED.length) return cb(null, true);
    if (!origin) return cb(null, true); // tools like curl/postman
    cb(null, ALLOWED.includes(origin));
  },
  credentials: true
};

// Multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 } // 30 MB
});

const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.get('/api/ping', (_req, res) => res.json({ ok: true, pong: true }));

// ---- Helpers
function cleanText(s) {
  return String(s || '')
    .replace(/\u0000/g, '')
    .replace(/[\t\r]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Rasterize PDF to PNG buffers (one per page)
async function rasterizePdfToPNGs(buffer, scale = 2) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push({ page: p, png: canvas.toBuffer('image/png') });
  }
  return out;
}

// Local OCR with tesseract.js
async function runLocalOCR(buffer, { langs = OCR_LANGS, rid = '-' } = {}) {
  if (!OCR_ENABLE) throw new Error('OCR disabilitato via env OCR_ENABLE=0');
  const label = `${rid}:OCR-local`;
  if (DEBUG) console.log(`[${label}] Avvio OCR locale (langs=${langs})`);
  const images = await rasterizePdfToPNGs(buffer, 2);
  const parts = [];
  for (const { page, png } of images) {
    const res = await Tesseract.recognize(png, langs);
    const text = res?.data?.text || '';
    parts.push(cleanText(text));
  }
  const joined = parts.join('\n\n').trim();
  if (DEBUG) console.log(`[${label}] Completato. Pagine=${parts.length} chars=${joined.length}`);
  if (!joined) throw new Error('OCR locale completato ma testo vuoto');
  return joined;
}

// Extract text from PDF: pdf-parse first, OCR fallback if empty
async function extractPdfText(buffer, rid = '-') {
  let txt = '';
  try {
    const data = await pdfParse(buffer);
    txt = cleanText(data.text || '');
  } catch (e) {
    if (DEBUG) console.warn(`[${rid}] pdf-parse errore:`, e?.message || e);
  }
  if (txt) return txt;
  // fallback OCR
  const ocr = await runLocalOCR(buffer, { rid });
  return ocr;
}

// ---- Routes
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nessun file caricato (usa campo "file")' });
    req._rid = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
    const text = await extractPdfText(req.file.buffer, req._rid);
    res.json({ ok: true, chars: text.length, text });
  } catch (err) {
    const msg = err?.message || String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

// Root info
app.get('/api/info', (_req, res) => {
  res.json({
    ok: true,
    ocr: OCR_ENABLE ? 'enabled-local' : 'disabled',
    langs: OCR_LANGS,
    limits: { uploadMB: 30 }
  });
});

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (OCR=${OCR_ENABLE?'on':'off'} langs=${OCR_LANGS})`);
});
