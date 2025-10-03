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
const OCR_LANGS = process.env.OCR_LANGS || 'eng';

// Comma-separated allowlist (es: https://tuo-sito.example,https://foo.bar)
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!ALLOWED.length) return cb(null, true);     // tutto consentito se vuoto (dev)
    if (!origin) return cb(null, true);             // curl/postman senza Origin
    return cb(null, ALLOWED.includes(origin));      // allowlist precisa
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
};

/* =========================
   Upload (PDF fino a 30MB)
   ========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
});

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

/** Estrazione testo nativa con pdfjs-dist (senza pdf-parse) */
async function extractTextWithPdfjs(buffer, rid = '-') {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
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

/** OCR locale con tesseract.js (fallback) */
async function runLocalOCR(buffer, { langs = OCR_LANGS, rid = '-' } = {}) {
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
pdfjsLib = await loadPdfjs();

// Health/info
app.get('/api/ping', (_req, res) => res.json({ ok: true, pong: true }));
app.get('/api/info', (_req, res) => res.json({ ok: true, ocr: 'local', langs: OCR_LANGS }));

// Estrazione pura
app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nessun file caricato (campo "file")' });
    const rid = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
    const text = await extractPdfText(req.file.buffer, rid);
    res.json({ ok: true, chars: text.length, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Flashcards (demo locale semplice)
function buildFlashcards(text, n = 12) {
  const sents = text.split(/\n+|\. +/).map(s => s.trim()).filter(s => s.length > 20);
  const pick = sents.slice(0, Math.min(n, sents.length));
  return pick.map((s, i) => ({
    id: i + 1,
    front: s.slice(0, 80) + (s.length > 80 ? '…' : ''),
    back: s,
    difficulty: 'media',
    tags: [],
  }));
}
app.post('/api/flashcards', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nessun file caricato (campo "file")' });
    const rid = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
    const text = await extractPdfText(req.file.buffer, rid);
    const cards = buildFlashcards(text, 12);
    res.json({ ok: true, count: cards.length, cards });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Avvio
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (OCR=local langs=${OCR_LANGS})`);
});
