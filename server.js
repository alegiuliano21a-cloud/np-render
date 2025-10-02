import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
// Import diretto del core per evitare il blocco di debug in index.js del pacchetto
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import OpenAI from 'openai';

// ===== Throttle & Queue (configurabili da ENV) =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OPENAI_RPM = parseInt(process.env.OPENAI_RPM || '30', 10);
const OPENAI_CONCURRENCY = parseInt(process.env.OPENAI_CONCURRENCY || '2', 10);

// Coda semplice per limitare la concorrenza delle chiamate OpenAI
const _queue = [];
let _active = 0;
async function _pump(){
  if (_active >= OPENAI_CONCURRENCY || !_queue.length) return;
  const { fn, resolve, reject } = _queue.shift();
  _active++;
  try { resolve(await fn()); }
  catch(e){ reject(e); }
  finally { _active--; setImmediate(_pump); }
}
function runQueued(fn){ return new Promise((resolve, reject)=>{ _queue.push({ fn, resolve, reject }); _pump(); }); }

// Throttle RPM su finestra mobile di 60s
let _winStart = 0;
let _reqInWindow = 0;
async function throttleRPM(){
  const now = Date.now();
  if (now - _winStart >= 60_000) { _winStart = now; _reqInWindow = 0; }
  if (_reqInWindow >= OPENAI_RPM) {
    const wait = 60_000 - (now - _winStart) + 50;
    await sleep(wait);
    _winStart = Date.now(); _reqInWindow = 0;
  }
  _reqInWindow++;
}

// Retry/backoff per 429 residuali
async function withRetries(fn, { retries=3, base=500 } = {}){
  let i=0;
  while(true){
    try { return await fn(); }
    catch(e){
      const status = e?.status || e?.code || e?.response?.status;
      if (status !== 429 || i >= retries) throw e;
      await sleep(base * Math.pow(2,i) + Math.random()*150);
      i++;
    }
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB

// CORS con allowlist per deploy su Render (gestisce anche preflight)
const allowlist = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);           // curl/postman
    if (!allowlist.length) return cb(null, true); // dev fallback
    return cb(null, allowlist.includes(origin));
  }
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8787;
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const openai = HAS_OPENAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
// Log config effettiva per debug (senza segreti)
const MODEL_CFG = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TOKENS_CFG = parseInt(process.env.OPENAI_MAX_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS || '800', 10);
console.log(`[studytool] OpenAI model=${MODEL_CFG} max_tokens=${MAX_TOKENS_CFG} rpm=${OPENAI_RPM} concurrency=${OPENAI_CONCURRENCY} hasOpenAI=${HAS_OPENAI}`);

/* =============================================================
   AUTH OPZIONALE PER LE ROTTE /api/* (eccetto /api/ping)
   ============================================================= */
const REQUIRED_KEY = process.env.SERVER_API_KEY || '';
app.use((req, res, next) => {
  if (req.path === '/api/ping') return next();
  if (!REQUIRED_KEY) return next(); // disattivato se non impostato
  if (req.get('x-api-key') === REQUIRED_KEY) return next();
  return res.status(401).json({ ok:false, error:'Unauthorized' });
});

/* =============================================================
   UTILITÀ
   ============================================================= */
function cleanText(t) {
  if (!t) return '';
  return t.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
}

function chunkText(txt, max = 8000) {
  // Semplice chunking per lunghi PDF
  const chunks = [];
  let i = 0;
  while (i < txt.length) {
    chunks.push(txt.slice(i, i + max));
    i += max;
  }
  return chunks;
}

function safeJSON(s) {
  // Prova a estrarre JSON tra ```json ... ``` o simili, poi parse
  if (!s) throw new Error("Risposta IA vuota");
  let m = s.match(/```json\s*([\s\S]*?)```/i);
  if (m) s = m[1];
  // Rimuove eventuali codefence generiche
  s = s.replace(/^```[\s\S]*?```$/gm, (x) => x.replace(/```/g, ''));
  // Tenta direttamente il parse
  try { return JSON.parse(s); } catch(e) {}
  // Prova a trovare il primo oggetto/array JSON plausibile
  const start = s.indexOf('{'); const startArr = s.indexOf('[');
  let idx = -1;
  if (start === -1 && startArr === -1) throw new Error("Nessun JSON trovato");
  if (start === -1) idx = startArr; else if (startArr === -1) idx = start; else idx = Math.min(start, startArr);
  let candidate = s.slice(idx);
  // Heuristica: tronca all'ultima } o ]
  const lastObj = candidate.lastIndexOf('}');
  const lastArr = candidate.lastIndexOf(']');
  let end = Math.max(lastObj, lastArr);
  if (end !== -1) candidate = candidate.slice(0, end + 1);
  return JSON.parse(candidate);
}

function pickN(arr, n) {
  const a = [...arr];
  const out = [];
  while (a.length && out.length < n) {
    const i = Math.floor(Math.random() * a.length);
    out.push(a.splice(i, 1)[0]);
  }
  return out;
}

// Fallback molto semplice per demo senza chiave: genera contenuti naïf dal testo
function dummySummary(text, length='medio') {
  const sents = text.split('. ').map(s => s.trim()).filter(Boolean);
  const take = length === 'breve' ? 3 : (length === 'esaustivo' ? 12 : 6);
  return sents.slice(0, take).join('. ') + (sents.length ? '.' : '');
}
function dummyFlashcards(text, n=10) {
  const words = Array.from(new Set(text.replace(/[^A-Za-zÀ-ÿ0-9 ]/g,' ').split(' ').filter(w => w.length>6))).slice(0, 100);
  const cards = [];
  for (let i=0;i<Math.min(n, 20);i++) {
    const term = words[i] || `Concetto ${i+1}`;
    cards.push({ front: term, back: `Definizione sintetica di ${term}.`, difficulty: 'media', tags: [] });
  }
  return cards;
}
function dummyQuiz(text, n=10) {
  const sents = Array.from(new Set(text.split('. ').map(s => s.trim()).filter(s => s.length>20)));
  const base = pickN(sents, Math.min(n, 15));
  const qs = base.map((s, idx) => {
    const stem = s.replace(/^\d+\)\s*/, '');
    const opt1 = stem.slice(0, Math.min(40, stem.length)) + '…';
    const opt2 = 'Nessuna delle precedenti';
    const opt3 = 'Tutte le precedenti';
    const opt4 = 'Non applicabile';
    return ({ question: `Q${idx+1}. ${stem}`, options: [opt1, opt2, opt3, opt4], correct: 0, explanation: 'Derivata dal testo del PDF (fallback demo).' });
  });
  return qs;
}

/* =============================================================
   PROMPTING
   ============================================================= */
async function askOpenAI_JSON(system, user, temperature=0.3) {
  if (!HAS_OPENAI) throw new Error("OPENAI non configurato");
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS || '800', 10);
  return runQueued(async () => {
    await throttleRPM();
    const resp = await withRetries(() => openai.chat.completions.create({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    }));
    const choice = resp.choices?.[0];
    const txt = choice?.message?.content || "";
    return safeJSON(txt);
  });
}

/* =============================================================
   RATE LIMIT SPREAD (ritardi in base alla dimensione del PDF)
   ============================================================= */
function computeSpreadDelay(totalChars){
  // Nessun delay se documento piccolo (<8k char)
  if (!HAS_OPENAI) return 0;
  const MIN = 8000, MAX = 50000; // coerente con chunk e truncation
  const MAX_MS = 120000; // 2 minuti
  const clamped = Math.max(0, Math.min(MAX, totalChars) - MIN);
  if (clamped <= 0) return 0;
  const span = MAX - MIN;
  return Math.floor((clamped / span) * MAX_MS);
}

async function buildSummary(text, subject, length) {
  if (!HAS_OPENAI) return { text: dummySummary(text, length) };
  const system = "Sei un assistente didattico che produce riassunti accurati in italiano. Rispondi SOLO in JSON valido.";
  const user = `
Crea un riassunto in italiano del seguente testo (materia: ${subject}).
LUNGHEZZA: ${length} (breve/medio/esaustivo). 
Formatta in JSON: {"text": "<riassunto>"}

TESTO:
"""${text}"""
  `.trim();
  const out = await askOpenAI_JSON(system, user, 0.3);
  if (!out.text) throw new Error("JSON senza campo 'text'");
  return out;
}

async function buildFlashcards(text, subject, n, difficulty) {
  if (!HAS_OPENAI) return { cards: dummyFlashcards(text, n) };
  const system = "Sei un assistente didattico. Genera flashcards Q&A in italiano. Rispondi SOLO in JSON valido.";
  const user = `
Dal testo seguente (materia: ${subject}) genera ${n} flashcards con difficoltà ${difficulty} (facile/media/difficile).
Formato JSON:
{"cards":[{"front":"<domanda/termine>","back":"<risposta/definizione>","difficulty":"<facile|media|difficile>","tags":["..."]}, ...]}

TESTO:
"""${text}"""
  `.trim();
  const out = await askOpenAI_JSON(system, user, 0.4);
  if (!out.cards || !Array.isArray(out.cards)) throw new Error("JSON senza 'cards'");
  return out;
}

async function buildQuiz(text, subject, n, difficulty) {
  if (!HAS_OPENAI) return { questions: dummyQuiz(text, n) };
  const system = "Sei un assistente che crea quiz a scelta multipla (4 opzioni) in italiano. Rispondi SOLO in JSON valido.";
  const user = `
Crea un quiz basato sul testo (materia: ${subject}).
Numero domande: ${n}. Difficoltà: ${difficulty} (facile/media/difficile).
Ogni domanda con 4 opzioni e un indice 'correct' (0..3) e 'explanation' breve.
Formato JSON:
{"questions":[{"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}, ...]}

TESTO:
"""${text}"""
  `.trim();
  const out = await askOpenAI_JSON(system, user, 0.4);
  if (!out.questions || !Array.isArray(out.questions)) throw new Error("JSON senza 'questions'");
  return out;
}

/* =============================================================
   API
   ============================================================= */
app.get('/api/ping', (req,res)=> res.json({ ok:true, hasOpenAI: HAS_OPENAI }));
// Endpoint info per verifica configurazione runtime (richiede x-api-key se attiva)
app.get('/api/info', (req,res)=>{
  res.json({
    ok: true,
    hasOpenAI: HAS_OPENAI,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS || '800', 10),
    rpm: OPENAI_RPM,
    concurrency: OPENAI_CONCURRENCY,
    allowedOrigins: allowlist
  });
});

async function extractPdfTextFromReq(req) {
  if (!req.file) throw new Error("PDF mancante (campo 'pdf')");
  const buffer = req.file.buffer;
  const data = await pdfParse(buffer);
  const txt = (data.text || '').replace(/\s+/g, ' ').trim();
  if (!txt) throw new Error("Impossibile estrarre testo dal PDF");
  return txt.slice(0, 50000);
}

app.post('/api/summary', upload.single('pdf'), async (req,res)=>{
  try{
    const subject = (req.body.subject || 'Generale').trim();
    const length = (req.body.length || 'medio').toLowerCase();
    const text = await extractPdfTextFromReq(req);
    const chunks = chunkText(text, 8000);
    // Delay complessivo proporzionale alla dimensione; spalmato sui chunk
    const totalDelay = computeSpreadDelay(text.length);
    const perChunkDelay = chunks.length ? Math.floor(totalDelay / chunks.length) : 0;
    if (totalDelay>0) console.log(`[rate-spread] totalDelay=${totalDelay}ms, perChunk=${perChunkDelay}ms, chunks=${chunks.length}`);
    let partials = [];
    for (let i=0; i<chunks.length; i++) {
      const c = chunks[i];
      if (i>0 && perChunkDelay>0) await sleep(perChunkDelay);
      const r = await buildSummary(c, subject, length);
      partials.push(r.text);
    }
    let finalText = partials.join("\n\n");
    if (partials.length > 1 && HAS_OPENAI) {
      if (perChunkDelay>0) await sleep(perChunkDelay);
      const r = await buildSummary(finalText, subject, length);
      finalText = r.text;
    }
    res.json({ ok:true, data: { text: finalText } });
  }catch(e){
    res.status(400).json({ ok:false, error: e.message || String(e) });
  }
});

app.post('/api/flashcards', upload.single('pdf'), async (req,res)=>{
  try{
    const subject = (req.body.subject || 'Generale').trim();
    const difficulty = (req.body.difficulty || 'media').toLowerCase();
    const n = Math.max(1, Math.min(parseInt(req.body.num || '12', 10), 60));
    const text = await extractPdfTextFromReq(req);
    const spread = computeSpreadDelay(text.length);
    if (spread>0) { console.log(`[rate-spread] flashcards delay=${spread}ms`); await sleep(spread); }
    const out = await buildFlashcards(text, subject, n, difficulty);
    res.json({ ok:true, data: out });
  }catch(e){
    res.status(400).json({ ok:false, error: e.message || String(e) });
  }
});

app.post('/api/quiz', upload.single('pdf'), async (req,res)=>{
  try{
    const subject = (req.body.subject || 'Generale').trim();
    const difficulty = (req.body.difficulty || 'media').toLowerCase();
    const n = Math.max(1, Math.min(parseInt(req.body.num || '15', 10), 60));
    const text = await extractPdfTextFromReq(req);
    const spread = computeSpreadDelay(text.length);
    if (spread>0) { console.log(`[rate-spread] quiz delay=${spread}ms`); await sleep(spread); }
    const out = await buildQuiz(text, subject, n, difficulty);
    // sanifica e limita a n
    const uniq = [];
    const seen = new Set();
    for (const q of out.questions) {
      const key = (q.question || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const opts = Array.isArray(q.options) ? q.options.slice(0,4) : [];
      if (opts.length < 4) continue;
      const correct = Math.max(0, Math.min(parseInt(q.correct,10) || 0, 3));
      uniq.push({ question: q.question, options: opts, correct, explanation: q.explanation || "" });
      if (uniq.length >= n) break;
    }
    if (!uniq.length) throw new Error("Nessuna domanda valida generata dall'IA");
    res.json({ ok:true, data: { questions: uniq } });
  }catch(e){
    res.status(400).json({ ok:false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[studytool] Server attivo sulla porta ${PORT}. OpenAI: ${HAS_OPENAI ? 'ON' : 'OFF'}`);
});
