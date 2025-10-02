# Deploy su Render — StudyTool Backend

## Comandi Render
- Build Command: `npm ci`
- Start Command: `npm start`

## Variabili d'ambiente (Dashboard Render)
- `OPENAI_API_KEY` (obbligatoria)
- `OPENAI_MODEL` (es. gpt-4o-mini; cambiabile senza code change)
- `OPENAI_MAX_TOKENS` (opzionale, default 800) — limita l'output per risposta
- `OPENAI_PROJECT` (opzionale, richiesto per chiavi `sk-proj-...`; inserisci l'ID `proj_...` del Project)
- `OPENAI_BASE_URL` (opzionale, per proxy/compat; lascia vuoto per API OpenAI standard)
- `OPENAI_RPM` (opzionale, default 30) — richieste/minuto verso OpenAI
- `OPENAI_CONCURRENCY` (opzionale, default 2) — chiamate OpenAI in parallelo
- `SPREAD_DISABLE` (opzionale, 1 per disattivare i ritardi proporzionali alla dimensione del PDF)
- `CHUNK_PAUSE_MS` (opzionale, pausa costante tra chunk in ms — utile per test rapidi senza spread)
- `OPENAI_MAX_INPUT_CHARS` (opzionale, default 50000) — limite caratteri testuali estratti dal PDF
- `SERVER_API_KEY` (consigliata)
- `ALLOWED_ORIGINS` (es. dominio GitHub Pages/dominio custom, separati da virgole)

### Uso con OpenRouter (alternativa a OpenAI)
- Imposta:
  - `OPENAI_BASE_URL=https://openrouter.ai/api/v1`
  - `OPENAI_API_KEY=sk-or-v1-...` (chiave OpenRouter)
  - `OPENAI_MODEL=openrouter/auto` (o per vendor specifico es. `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`)
- Lascia vuoto `OPENAI_PROJECT` (non serve con OpenRouter)
- (Facoltativo) Header consigliati da OpenRouter: puoi impostare anche `OPENROUTER_SITE_URL` e `OPENROUTER_APP_TITLE` (non obbligatori)

## Endpoint test
- `GET /api/ping` → `{ ok:true, hasOpenAI: true|false }`

## Limiti
- Upload PDF: 25 MB

## Note
- Senza `OPENAI_API_KEY`, il server usa generatori fallback “demo” (non adatto a produzione).
- Tenere le chiavi SOLO come variabili d'ambiente su Render; nessun segreto nel frontend.
- Il server applica una "rate limit spread" dinamica: per PDF grandi inserisce attese fino a 120s totali per ridurre i 429; configurazione automatica, nessuna azione richiesta lato client.
- Throttle/coda lato server: coda con concorrenza max e limite RPM via env (`OPENAI_CONCURRENCY`, `OPENAI_RPM`).
 - Log dettagliati: abilita `DEBUG_LOG=1` per vedere step/ritardi/chunk e tempi per ogni richiesta.
