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
const SPREAD_DISABLE = process.env.SPREAD_DISABLE === '1';
const CHUNK_PAUSE_MS = parseInt(process.env.CHUNK_PAUSE_MS || '0', 10);
const MAX_INPUT_CHARS = parseInt(process.env.OPENAI_MAX_INPUT_CHARS || '50000', 10);

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
    if (DEBUG_LOG) console.log(`[${globalThis.__currentRid||'-'}][throttle] window ${_reqInWindow}/${OPENAI_RPM} wait ${wait}ms`);
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
// Debug verbose abilitabile da ENV
const DEBUG_LOG = (process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true');
// Middleware: assegna un request-id e logga inizio/fine
app.use((req, res, next) => {
  const rid = Math.random().toString(36).slice(2,8) + '-' + Date.now().toString(36).slice(-4);
  req._rid = rid;
  const start = Date.now();
  res.setHeader('x-request-id', rid);
  console.log(`[${rid}] ${req.method} ${req.path} from ${req.ip || 'unknown'}`);
  res.on('finish', () => {
    console.log(`[${rid}] done ${res.statusCode} in ${Date.now()-start}ms`);
  });
  next();
});

const PORT = process.env.PORT || 8787;
const apiKeyRaw = process.env.OPENAI_API_KEY || '';
const apiKey = apiKeyRaw.trim();
const HAS_OPENAI = !!apiKey;
const clientOpts = { apiKey };
if ((process.env.OPENAI_PROJECT||'').trim()) clientOpts.project = (process.env.OPENAI_PROJECT||'').trim();
if ((process.env.OPENAI_BASE_URL||'').trim()) clientOpts.baseURL = (process.env.OPENAI_BASE_URL||'').trim();
const openai = HAS_OPENAI ? new OpenAI(clientOpts) : null;
// Log config effettiva per debug (senza segreti)
const MODEL_CFG = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TOKENS_CFG = parseInt(process.env.OPENAI_MAX_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS || '800', 10);
const OCR_ENABLED = process.env.OCR_ENABLE ? process.env.OCR_ENABLE !== '0' : true;
const OCR_MODEL_CFG = process.env.OPENAI_OCR_MODEL || MODEL_CFG;
const OCR_MAX_OUTPUT_TOKENS = parseInt(process.env.OPENAI_OCR_MAX_OUTPUT_TOKENS || '2000', 10);
const KEY_TYPE = apiKey.startsWith('sk-proj-') ? 'project' : (apiKey.startsWith('sk-') ? 'user' : (apiKey ? 'unknown' : 'none'));
const KEY_LEN = apiKey.length;
console.log(`[studytool] OpenAI model=${MODEL_CFG} max_tokens=${MAX_TOKENS_CFG} rpm=${OPENAI_RPM} concurrency=${OPENAI_CONCURRENCY} hasOpenAI=${HAS_OPENAI} keyType=${KEY_TYPE} keyLen=${KEY_LEN} project=${process.env.OPENAI_PROJECT? 'set':''} baseURL=${process.env.OPENAI_BASE_URL? 'set':''} ocrEnabled=${OCR_ENABLED} ocrModel=${OCR_MODEL_CFG}`);

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

function collectResponseText(resp) {
  if (!resp) return '';
  if (Array.isArray(resp.output_text) && resp.output_text.length) {
    return resp.output_text.join('\n');
  }
  const out = [];
  const items = Array.isArray(resp.output) ? resp.output : [];
  for (const item of items) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const chunk of item.content) {
        if (chunk?.type === 'output_text' && typeof chunk.text === 'string') {
          out.push(chunk.text);
        }
      }
    } else if (item?.type === 'output_text' && typeof item.text === 'string') {
      out.push(item.text);
    }
  }
  return out.join('\n');
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

async function runPdfOCR(buffer, rid = '-') {
  if (!OCR_ENABLED) throw new Error('OCR disabilitato');
  if (!HAS_OPENAI) throw new Error('OCR non disponibile: OPENAI non configurato');
  const label = `${rid}:OCR`;
  const model = OCR_MODEL_CFG;
  console.log(`[${label}] fallback OCR attivo con modello ${model}`);
  const upload = await OpenAI.toFile(buffer, 'upload.pdf');
  const file = await runQueued(async () => {
    await throttleRPM();
    return await withRetries(() => openai.files.create({
      file: upload,
      purpose: 'assistants'
    }));
  });
  try {
    const response = await runQueued(async () => {
      await throttleRPM();
      return await withRetries(() => openai.responses.create({
        model,
        temperature: 0,
        max_output_tokens: OCR_MAX_OUTPUT_TOKENS,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Sei un motore OCR. Leggi il PDF allegato ed estrai esclusivamente il testo leggibile pagina per pagina, mantenendo l\'ordine di lettura. Restituisci solo testo puro, usando una riga vuota tra le pagine.'
              },
              {
                type: 'input_file',
                file_id: file.id
              }
            ]
          }
        ]
      }));
    });
    const raw = collectResponseText(response);
    const cleaned = cleanText(raw).trim();
    if (!cleaned) throw new Error('OCR completato ma testo vuoto');
    console.log(`[${label}] OCR completato. Caratteri estratti=${cleaned.length}`);
    return cleaned.slice(0, MAX_INPUT_CHARS);
  } finally {
    await runQueued(async () => {
      try { await openai.files.del(file.id); }
      catch (err) { if (DEBUG_LOG) console.warn(`[${label}] cleanup file OCR fallito:`, err?.message || err); }
    });
  }
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
async function askOpenAI_JSON(system, user, temperature=0.3, opts={}) {
  if (!HAS_OPENAI) throw new Error("OPENAI non configurato");
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || process.env.OPENAI_MAX_OUTPUT_TOKENS || '800', 10);
  const rid = globalThis.__currentRid || '-';
  const attemptsCfg = parseInt(process.env.OPENAI_JSON_ATTEMPTS || '5', 10);
  const attempts = Math.max(1, parseInt(opts.attempts || attemptsCfg || 2, 10));
  const schema = opts.schema || null;
  const schemaName = opts.schemaName || 'response';
  const responseFormat = schema
    ? { type: 'json_schema', json_schema: { name: schemaName, schema } }
    : { type: 'json_object' };
  if (DEBUG_LOG) console.log(`[${rid}] enqueue openai model=${MODEL} temp=${temperature} max_tokens=${maxTokens} q=${_queue.length} a=${_active} attempts=${attempts} schema=${schema?'on':'off'}`);
  return runQueued(async () => {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const t0 = Date.now();
        if (DEBUG_LOG) console.log(`[${rid}] start openai model=${MODEL} attempt=${attempt}/${attempts}`);
        await throttleRPM();
        const basePayload = {
          model: MODEL,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        };
        const call = (payload) => withRetries(() => openai.chat.completions.create(payload));
        let resp;
        let usedNativeJson = false;
        try {
          resp = await call({ ...basePayload, response_format: responseFormat });
          usedNativeJson = true;
        } catch (err) {
          const errMsg = (err?.error?.message || err?.message || '').toLowerCase();
          if (err?.status === 400 && errMsg.includes('response_format')) {
            if (DEBUG_LOG) console.warn(`[${rid}] response_format unsupported, falling back to text JSON parsing`);
            resp = await call(basePayload);
          } else {
            throw err;
          }
        }
        const choice = resp.choices?.[0];
        if (DEBUG_LOG) console.log(`[${rid}] openai done in ${Date.now()-t0}ms finish=${choice?.finish_reason||'-'} attempt=${attempt}`);
        const parsed = choice?.message?.parsed;
        if (usedNativeJson && parsed) return parsed;
        const content = choice?.message?.content;
        let txt = '';
        if (Array.isArray(content)) {
          txt = content.map(part => part?.text || '').join('').trim();
        } else if (typeof content === 'string') {
          txt = content;
        }
        if (!txt && usedNativeJson) throw new Error('Risposta OpenAI senza JSON');
        try {
          return safeJSON(txt);
        } catch (parseErr) {
          if (DEBUG_LOG) console.warn(`[${rid}] safeJSON failed: ${parseErr.message}. Snippet: ${txt.slice(0,180)}...`);
          throw parseErr;
        }
      } catch (err) {
        lastErr = err;
        if (DEBUG_LOG) console.warn(`[${rid}] askOpenAI_JSON attempt ${attempt} failed: ${err.message}`);
        if (attempt < attempts) await sleep(150 * attempt);
      }
    }
    throw lastErr || new Error('Impossibile ottenere JSON valido da OpenAI');
  });
}

/* =============================================================
   RATE LIMIT SPREAD (ritardi in base alla dimensione del PDF)
   ============================================================= */
function computeSpreadDelay(){ return 0; }

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
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'Riassunto in italiano del testo fornito' }
    },
    required: ['text']
  };
  const out = await askOpenAI_JSON(system, user, 0.3, { schemaName: 'summary_response', schema });
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
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      cards: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            front: { type: 'string' },
            back: { type: 'string' },
            difficulty: { type: 'string', enum: ['facile', 'media', 'difficile'] },
            tags: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['front', 'back']
        }
      }
    },
    required: ['cards']
  };
  const out = await askOpenAI_JSON(system, user, 0.4, { schemaName: 'flashcards_response', schema });
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
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string' },
            options: {
              type: 'array',
              items: { type: 'string' },
              minItems: 4,
              maxItems: 4
            },
            correct: { type: 'integer', minimum: 0, maximum: 3 },
            explanation: { type: 'string' }
          },
          required: ['question', 'options', 'correct']
        }
      }
    },
    required: ['questions']
  };
  const out = await askOpenAI_JSON(system, user, 0.4, { schemaName: 'quiz_response', schema });
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
    project: process.env.OPENAI_PROJECT ? 'set' : '',
    baseURL: process.env.OPENAI_BASE_URL ? 'set' : '',
    keyType: KEY_TYPE,
    keyLen: KEY_LEN,
    rpm: OPENAI_RPM,
    concurrency: OPENAI_CONCURRENCY,
    allowedOrigins: allowlist
  });
});

// Endpoint diagnostico: verifica chiamata minima a OpenAI
app.get('/api/debug/openai', async (req,res)=>{
  try{
    if (!HAS_OPENAI) return res.status(400).json({ ok:false, error: 'OPENAI_API_KEY mancante' });
    const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const t0 = Date.now();
    const r = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 5,
      messages: [ { role:'system', content:'You are a health check.' }, { role:'user', content:'pong' } ]
    });
    return res.json({ ok:true, ms: Date.now()-t0, finish: r.choices?.[0]?.finish_reason || '', created: r.created });
  }catch(e){
    const status = e?.status || e?.code || e?.response?.status || 0;
    return res.status(400).json({ ok:false, status, error: e?.message || String(e) });
  }
});

async function extractPdfTextFromReq(req) {
  if (!req.file) throw new Error("PDF mancante (campo 'pdf')");
  const buffer = req.file.buffer;
  let txt = '';
  let pageFrom = parseInt(req.body.page_from, 10);
  let pageTo = parseInt(req.body.page_to, 10);
  try {
    const data = await pdfParse(buffer);
    if (data.numpages && pageFrom && pageTo && pageFrom <= pageTo && pageFrom >= 1 && pageTo <= data.numpages) {
      const pages = (data.text || '').split(/\f|\n\s*\n/);
      const selected = pages.slice(pageFrom - 1, pageTo);
      txt = selected.join(' ').replace(/\s+/g, ' ').trim();
      console.log(`[${req._rid||'-'}] PDF: Elaboro solo pagine ${pageFrom}-${pageTo} su ${data.numpages}. Pagine selezionate: ${selected.length}`);
      selected.forEach((p, i) => console.log(`[${req._rid||'-'}] Pagina ${pageFrom + i}: ${p.slice(0, 60).replace(/\s+/g, ' ')}...`));
    } else {
      txt = (data.text || '').replace(/\s+/g, ' ').trim();
      console.log(`[${req._rid||'-'}] PDF: Nessun intervallo selezionato, elaboro tutto il PDF (${data.numpages || '?'} pagine)`);
    }
  } catch (err) {
    console.warn(`[${req._rid||'-'}] Errore pdf-parse: ${err?.message || err}`);
  }
  if (!txt) {
    console.log(`[${req._rid||'-'}] Nessun testo PDF estratto. Avvio fallback OCR...`);
    try {
      txt = await runPdfOCR(buffer, req._rid || '-');
      if (pageFrom && pageTo && pageFrom <= pageTo) {
        const ocrPages = txt.split(/\n\s*\n/);
        const selected = ocrPages.slice(pageFrom - 1, pageTo);
        txt = selected.join(' ').replace(/\s+/g, ' ').trim();
        console.log(`[${req._rid||'-'}] OCR: Elaboro solo pagine ${pageFrom}-${pageTo}. Pagine selezionate: ${selected.length}`);
        selected.forEach((p, i) => console.log(`[${req._rid||'-'}] Pagina OCR ${pageFrom + i}: ${p.slice(0, 60).replace(/\s+/g, ' ')}...`));
      } else {
        console.log(`[${req._rid||'-'}] OCR: Nessun intervallo selezionato, elaboro tutto il PDF`);
      }
    } catch (ocrErr) {
      const reason = ocrErr?.message || String(ocrErr);
      throw new Error(`Impossibile estrarre testo dal PDF (OCR fallito: ${reason})`);
    }
  }
  if (!txt) throw new Error("Impossibile estrarre testo dal PDF");
  return txt.slice(0, MAX_INPUT_CHARS);
}

app.post('/api/summary', upload.single('pdf'), async (req,res)=>{
  try{
    const subject = (req.body.subject || 'Generale').trim();
    const length = (req.body.length || 'medio').toLowerCase();
    const text = await extractPdfTextFromReq(req);
    const chunks = chunkText(text, 8000);
    const rid = req._rid; console.log(`[${rid}] summary: subject=${subject} length=${length} chars=${text.length} chunks=${chunks.length}`);
    // Delay complessivo proporzionale alla dimensione; spalmato sui chunk
    const totalDelay = computeSpreadDelay(text.length);
    const perChunkDelay = chunks.length ? Math.floor(totalDelay / chunks.length) : 0;
    if (totalDelay>0) console.log(`[rate-spread] totalDelay=${totalDelay}ms, perChunk=${perChunkDelay}ms, chunks=${chunks.length}`);
    let partials = [];
    for (let i=0; i<chunks.length; i++) {
      const c = chunks[i];
      const sleepMs = (perChunkDelay>0) ? perChunkDelay : CHUNK_PAUSE_MS;
      if (i>0 && sleepMs>0) await sleep(sleepMs);
      globalThis.__currentRid = `${rid}:S${i+1}/${chunks.length}`;
      const t0 = Date.now();
      const r = await buildSummary(c, subject, length);
      if (DEBUG_LOG) console.log(`[${globalThis.__currentRid}] chunk done in ${Date.now()-t0}ms textLen=${(r.text||'').length}`);
      partials.push(r.text);
    }
    let finalText = partials.join("\n\n");
    if (partials.length > 1 && HAS_OPENAI) {
      const sleepMs = (perChunkDelay>0) ? perChunkDelay : CHUNK_PAUSE_MS;
      if (sleepMs>0) await sleep(sleepMs);
      globalThis.__currentRid = `${rid}:S-MERGE`;
      const t0 = Date.now();
      const r = await buildSummary(finalText, subject, length);
      if (DEBUG_LOG) console.log(`[${globalThis.__currentRid}] merge done in ${Date.now()-t0}ms len=${(r.text||'').length}`);
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
    const delay = (spread>0) ? spread : CHUNK_PAUSE_MS;
    if (delay>0) { console.log(`[rate-spread] flashcards delay=${delay}ms`); await sleep(delay); }
    const rid = req._rid; globalThis.__currentRid = `${rid}:F`;
    console.log(`[${rid}] flashcards: subject=${subject} diff=${difficulty} n=${n} chars=${text.length}`);
    const t0 = Date.now();
    const out = await buildFlashcards(text, subject, n, difficulty);
    if (DEBUG_LOG) console.log(`[${rid}] flashcards built in ${Date.now()-t0}ms count=${(out.cards||[]).length}`);
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
    const delay = (spread>0) ? spread : CHUNK_PAUSE_MS;
    if (delay>0) { console.log(`[rate-spread] quiz delay=${delay}ms`); await sleep(delay); }
    const rid = req._rid; globalThis.__currentRid = `${rid}:Q`;
    console.log(`[${rid}] quiz: subject=${subject} diff=${difficulty} n=${n} chars=${text.length}`);
    const t0 = Date.now();
    const out = await buildQuiz(text, subject, n, difficulty);
    if (DEBUG_LOG) console.log(`[${rid}] quiz built in ${Date.now()-t0}ms raw=${(out.questions||[]).length}`);
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
