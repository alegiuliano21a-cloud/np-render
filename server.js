import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

// OCR locale
import { createCanvas } from 'canvas';
import Tesseract from 'tesseract.js';

/* =========================
   ENV & CORS
   ========================= */
const PORT = parseInt(process.env.PORT || '8787', 10);
const DEBUG = (process.env.DEBUG_LOG || '0') !== '0';
const OCR_LANGS = process.env.OCR_LANGS || 'eng';      // es: "eng" oppure "eng+ita"
const OCR_SCALE = parseFloat(process.env.OCR_SCALE || '2'); // scala raster (2 = qualità buona)

// Comma-separated allowlist (es: https://tuo-sito.example,https://foo.bar)
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!ALLOWED.length) return cb(null, true); // tutto consentito se vuoto (dev)
    if (!origin) return cb(null, true);         // curl/postman senza Origin
    const ok = ALLOWED.includes(origin);
    if (!ok && DEBUG) console.warn(`[CORS] Origin non ammessa: ${origin}`);
    return cb(null, ok);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
};

/* =========================
   Upload (PDF fino a 30MB)
   ========================= */
// Usiamo .any() per evitare "Unexpected field" se il frontend usa nomi diversi
const storage = multer.memoryStorage();
const limits = { fileSize: 30 * 1024 * 1024 }; // 30 MB
const uploadAny = multer({ storage, limits }).any();

/* =========================
   Loader dinamico pdfjs-dist
   ========================= */
let pdfjsLib; // verrà assegnata all’avvio
async function loadPdfjs() {
  const tries = [
    'pdfjs-dist/legacy/build/pdf.mjs',
    'pdfjs-dist/build/pdf.mjs',
    'pdfjs-dist', // alcune versioni risolvono così
  ];
  let lastErr;
  for (const spec of tries) {
    try {
      const mod = await import(spec);
      if (DEBUG) console.log(`[pdfjs] loaded: ${spec}`);
      return mod;
    } catch (e) {
      lastErr = e;
      if (DEBUG) console.warn(`[pdfjs] failed ${spec}: ${e?.message || e}`);
    }
  }
  throw new Error(`Impossibile caricare pdfjs-dist: ${lastErr?.message || lastErr}`);
}

/* =========================
   Helpers
   ========================= */
function cleanText(s) {
  return String(s || '')
    .replace(/\u0000/g, '')
    .replace(/[\t\r]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Converte Buffer/ArrayBuffer → Uint8Array per pdfjs (no Buffer!)
function toUint8(buf) {
  // 1) Node Buffer -> crea sempre una vista Uint8Array "pura"
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  // 2) Già Uint8Array (ma non Buffer)
  if (buf instanceof Uint8Array) return buf;
  // 3) ArrayBuffer
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  // 4) Fallback: prova a costruire una vista
  return new Uint8Array(buf);
}

// Trova il primo file PDF valido tra req.files (multer.any())
function pickPdfFile(req) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return null;
  const byMime = files.find(f => (f.mimetype || '').toLowerCase() === 'application/pdf');
  if (byMime) return byMime;
  const byExt = files.find(f => (f.originalname || '').toLowerCase().endsWith('.pdf'));
  return byExt || null;
}

/** Estrazione testo nativa con pdfjs-dist (senza pdf-parse) */
async function extractTextWithPdfjs(buffer, rid = '-') {
  const data = toUint8(buffer);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    pages.push(text);
  }
  const joined = pages.join('\n\n').trim();
  if (DEBUG) console.log(`[${rid}] pdfjs text extract: pages=${pages.length} chars=${joined.length}`);
  return joined;
}

/** Rasterizza le pagine → PNG in memoria */
async function rasterizePdfToPNGs(buffer, scale = OCR_SCALE) {
  const data = toUint8(buffer);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const W = Math.max(1, Math.round(viewport.width));
    const H = Math.max(1, Math.round(viewport.height));
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push({ page: p, png: canvas.toBuffer('image/png') });
  }
  return out;
}

/** OCR locale con tesseract.js (fallback con retry lingua 'eng') */
async function runLocalOCR(buffer, { langs = OCR_LANGS, rid = '-' } = {}) {
  const label = `${rid}:OCR-local`;
  if (DEBUG) console.log(`[${label}] Avvio OCR locale (langs=${langs}, scale=${OCR_SCALE})`);
  const images = await rasterizePdfToPNGs(buffer, OCR_SCALE);
  const parts = [];
  for (const { png } of images) {
    try {
      const res = await Tesseract.recognize(png, langs);
      parts.push(cleanText(res?.data?.text || ''));
    } catch (err) {
      if (DEBUG) console.warn(
        `[${label}] OCR failed with "${langs}", retry on "eng":`,
        err?.message || err
      );
      const fallback = await Tesseract.recognize(png, 'eng');
      parts.push(cleanText(fallback?.data?.text || ''));
    }
  }
  const joined = parts.join('\n\n').trim();
  if (!joined) throw new Error('OCR locale completato ma testo vuoto');
  if (DEBUG) console.log(`[${label}] Completato. Pagine=${parts.length} chars=${joined.length}`);
  return joined;
}

/** Flusso principale: pdfjs testo → se vuoto → OCR */
async function extractPdfText(buffer, rid = '-') {
  let txt = '';
  try {
    txt = await extractTextWithPdfjs(buffer, rid);
  } catch (e) {
    if (DEBUG) console.warn(`[${rid}] pdfjs text extract error:`, e?.message || e);
  }
  if (txt) return cleanText(txt);

  console.log(`[${rid}] Nessun testo PDF estratto. Avvio OCR locale...`);
  const ocr = await runLocalOCR(buffer, { rid });
  return ocr;
}

/* =========================
   App & Routes
   ========================= */
const app = express();

// CORS PRIMA delle route
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight
app.use(express.json({ limit: '1mb' }));

// Carica pdfjs-dist una volta all’avvio
pdfjsLib = await loadPdfjs(); // (nessuna modifica a GlobalWorkerOptions)

// Health/info
app.get('/api/ping', (_req, res) => res.json({ ok: true, pong: true }));
app.get('/api/info', (_req, res) => res.json({ ok: true, ocr: 'local', langs: OCR_LANGS, scale: OCR_SCALE }));

// Estrazione pura (accetta qualsiasi nome di campo)
app.post('/api/extract', (req, res) => {
  uploadAny(req, res, async (err) => {
    const rid = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
    if (err) {
      const code = err.code || 'UPLOAD_ERROR';
      const msg = err.message || String(err);
      if (DEBUG) console.warn(`[${rid}] Multer error:`, code, msg);
      return res.status(400).json({ ok: false, error: `Upload fallito (${code}): ${msg}` });
    }
    const file = pickPdfFile(req);
    if (!file) {
      return res.status(400).json({ ok: false, error: 'Nessun PDF trovato nel multipart (usa campo "file" o invia un .pdf)' });
    }
    try {
      const text = await extractPdfText(file.buffer, rid);
      res.json({ ok: true, chars: text.length, text });
    } catch (e) {
      if (DEBUG) console.error(`[${rid}] ERROR:`, e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
});

// Flashcards (demo locale semplice; accetta qualsiasi nome di campo)
function buildFlashcards(text, n = 12) {
  const sents = (text || '').split(/\n+|\. +/).map(s => s.trim()).filter(s => s.length > 20);
  const pick = sents.slice(0, Math.min(n, sents.length));
  return pick.map((s, i) => ({
    id: i + 1,
    front: s.slice(0, 80) + (s.length > 80 ? '…' : ''),
    back: s,
    difficulty: 'media',
    tags: [],
  }));
}
app.post('/api/flashcards', (req, res) => {
  uploadAny(req, res, async (err) => {
    const rid = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
    if (err) {
      const code = err.code || 'UPLOAD_ERROR';
      const msg = err.message || String(err);
      if (DEBUG) console.warn(`[${rid}] Multer error:`, code, msg);
      return res.status(400).json({ ok: false, error: `Upload fallito (${code}): ${msg}` });
    }
    const file = pickPdfFile(req);
    if (!file) {
      return res.status(400).json({ ok: false, error: 'Nessun PDF trovato nel multipart (usa campo "file" o invia un .pdf)' });
    }
    try {
      const text = await extractPdfText(file.buffer, rid);
      const cards = buildFlashcards(text, 12);
      res.json({ ok: true, count: cards.length, cards });
    } catch (e) {
      if (DEBUG) console.error(`[${rid}] ERROR:`, e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
});

// Avvio
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (OCR=local langs=${OCR_LANGS} scale=${OCR_SCALE})`);
});
