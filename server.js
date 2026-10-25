const express = require('express');
const path = require('path');
const { Pool, types } = require('pg');
const webpush = require('web-push');

// ---------------------------------------------------------------------------
// Configurazione dei turni di pulizia
// ---------------------------------------------------------------------------
const PEOPLE = ['Giulia', 'Ellen', 'Claudia'];
const TASKS = { bagno: 'Bagno', cucina: 'Cucina & corridoio' };
const START_DATE = '2026-10-27'; // martedì: ogni turno dura una settimana (mar → lun)
const END_DATE = '2026-12-31';   // si generano tutte le settimane che iniziano entro questa data

// Rotazione: chi era libera fa il bagno, chi ha fatto il bagno fa la cucina, chi ha fatto la cucina riposa.
// Settimana 1: Giulia bagno, Claudia cucina, Ellen libera.
const BAGNO_ROTATION = ['Giulia', 'Ellen', 'Claudia'];
const CUCINA_ROTATION = ['Claudia', 'Giulia', 'Ellen'];

const TIME_ZONE = 'Europe/Rome';
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
types.setTypeParser(1082, (v) => v); // le colonne DATE restano stringhe 'YYYY-MM-DD'

if (!process.env.DATABASE_URL) {
  console.error('Manca DATABASE_URL: aggiungi un database PostgreSQL al progetto Railway.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      week_start DATE NOT NULL,
      task TEXT NOT NULL,
      person TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (week_start, task)
    );
    CREATE TABLE IF NOT EXISTS swap_requests (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('scambio', 'cessione')),
      from_person TEXT NOT NULL,
      to_person TEXT NOT NULL,
      from_shift_id INT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      to_shift_id INT REFERENCES shifts(id) ON DELETE CASCADE,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'in_attesa',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS wake_times (
      person TEXT NOT NULL,
      day DATE NOT NULL,
      time TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (person, day)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS shopping_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      qty TEXT,
      added_by TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      done_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      done_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await initPush();

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM shifts');
  if (rows[0].n > 0) return;

  let week = START_DATE;
  let i = 0;
  while (week <= END_DATE) {
    await pool.query(
      'INSERT INTO shifts (week_start, task, person) VALUES ($1, $2, $3), ($1, $4, $5)',
      [week, 'bagno', BAGNO_ROTATION[i % 3], 'cucina', CUCINA_ROTATION[i % 3]]
    );
    week = addDays(week, 7);
    i++;
  }
  console.log(`Creati i turni per ${i} settimane a partire dal ${START_DATE}.`);
}

// ---------------------------------------------------------------------------
// Notifiche push
// ---------------------------------------------------------------------------
let vapidPublicKey = null;

async function initPush() {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    // Nessuna chiave nelle variabili: le generiamo una volta e le teniamo nel database
    const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key IN ('vapid_public', 'vapid_private')`);
    const saved = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (saved.vapid_public && saved.vapid_private) {
      pub = saved.vapid_public; priv = saved.vapid_private;
    } else {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey; priv = keys.privateKey;
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [pub, priv]
      );
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:turni-casa@example.com', pub, priv);
  vapidPublicKey = pub;
}

async function notifyOthers(person, payload) {
  const { rows } = await pool.query('SELECT endpoint, data FROM push_subscriptions WHERE person <> $1', [person]);
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(r.data, JSON.stringify(payload), { TTL: 12 * 3600 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [r.endpoint]);
      } else {
        console.error('Invio notifica non riuscito:', err.statusCode, err.body || err.message);
      }
    }
  }));
}

const romeToday = () => new Date().toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
function dayLabel(day) {
  const d = new Date(day + 'T12:00:00Z');
  const base = `${GIORNI[d.getUTCDay()]} ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`;
  const today = romeToday();
  if (day === today) return `oggi (${base})`;
  if (day === addDays(today, 1)) return `domani (${base})`;
  return base;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (!(err instanceof HttpError)) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Errore del server, riprova.' });
  });
const isPerson = (p) => PEOPLE.includes(p);

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => res.json({ people: PEOPLE, tasks: TASKS }));

app.get('/api/shifts', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shifts ORDER BY week_start, task');
  res.json(rows);
}));

app.patch('/api/shifts/:id/done', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE shifts SET done = $1 WHERE id = $2 RETURNING *',
    [Boolean(req.body.done), req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Turno non trovato.');
  res.json(rows[0]);
}));

app.get('/api/requests', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM swap_requests ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
}));

app.post('/api/requests', wrap(async (req, res) => {
  const { kind, from_person, to_person, from_shift_id, to_shift_id, message } = req.body;
  if (kind !== 'scambio') throw new HttpError(400, 'Si possono chiedere solo scambi.');
  if (!isPerson(from_person) || !isPerson(to_person)) throw new HttpError(400, 'Persona non valida.');
  if (from_person === to_person) throw new HttpError(400, 'Scegli un’altra persona.');

  const { rows: [a] } = await pool.query('SELECT * FROM shifts WHERE id = $1', [from_shift_id]);
  if (!a || a.person !== from_person) throw new HttpError(400, 'Questo turno non è tuo.');

  const { rows: [b] } = await pool.query('SELECT * FROM shifts WHERE id = $1', [to_shift_id]);
  if (!b || b.person !== to_person) throw new HttpError(400, `Il turno scelto non è di ${to_person}.`);

  const { rows: pending } = await pool.query(
    `SELECT id FROM swap_requests WHERE status = 'in_attesa' AND from_shift_id = $1`, [from_shift_id]
  );
  if (pending.length) throw new HttpError(409, 'Hai già una richiesta in attesa per questo turno.');

  const { rows } = await pool.query(
    `INSERT INTO swap_requests (kind, from_person, to_person, from_shift_id, to_shift_id, message)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [kind, from_person, to_person, from_shift_id, to_shift_id,
     (message || '').toString().slice(0, 300) || null]
  );
  res.status(201).json(rows[0]);
}));

async function resolveRequest(id, person, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query('SELECT * FROM swap_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new HttpError(404, 'Richiesta non trovata.');
    if (r.status !== 'in_attesa') throw new HttpError(409, 'Questa richiesta è già stata gestita.');

    if (action === 'cancel') {
      if (person !== r.from_person) throw new HttpError(403, 'Solo chi ha fatto la richiesta può annullarla.');
      await client.query(`UPDATE swap_requests SET status = 'annullata', resolved_at = now() WHERE id = $1`, [id]);
    } else if (action === 'reject') {
      if (person !== r.to_person) throw new HttpError(403, 'Questa richiesta non è rivolta a te.');
      await client.query(`UPDATE swap_requests SET status = 'rifiutata', resolved_at = now() WHERE id = $1`, [id]);
    } else {
      if (person !== r.to_person) throw new HttpError(403, 'Questa richiesta non è rivolta a te.');
      const ids = [r.from_shift_id, r.to_shift_id].filter(Boolean);
      const { rows: shifts } = await client.query('SELECT * FROM shifts WHERE id = ANY($1) FOR UPDATE', [ids]);
      const a = shifts.find((s) => s.id === r.from_shift_id);
      const b = shifts.find((s) => s.id === r.to_shift_id);
      const stillValid = a && a.person === r.from_person && (r.kind === 'cessione' || (b && b.person === r.to_person));
      if (!stillValid) {
        await client.query(`UPDATE swap_requests SET status = 'superata', resolved_at = now() WHERE id = $1`, [id]);
        await client.query('COMMIT');
        throw new HttpError(409, 'I turni sono cambiati nel frattempo: la richiesta non è più valida.');
      }
      await client.query('UPDATE shifts SET person = $1, done = false WHERE id = $2', [r.to_person, a.id]);
      if (r.kind === 'scambio') {
        await client.query('UPDATE shifts SET person = $1, done = false WHERE id = $2', [r.from_person, b.id]);
      }
      await client.query(`UPDATE swap_requests SET status = 'accettata', resolved_at = now() WHERE id = $1`, [id]);
      // Le altre richieste in attesa sugli stessi turni non hanno più senso
      await client.query(
        `UPDATE swap_requests SET status = 'superata', resolved_at = now()
         WHERE status = 'in_attesa' AND id <> $1 AND (from_shift_id = ANY($2) OR to_shift_id = ANY($2))`,
        [id, ids]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

for (const action of ['accept', 'reject', 'cancel']) {
  app.post(`/api/requests/:id/${action}`, wrap(async (req, res) => {
    await resolveRequest(req.params.id, req.body.person, action);
    res.json({ ok: true });
  }));
}

// --- Sveglia ---
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

app.get('/api/wake', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT person, day, time FROM wake_times ORDER BY day, person');
  res.json(rows);
}));

app.put('/api/wake', wrap(async (req, res) => {
  const { person, day, time } = req.body;
  if (!isPerson(person)) throw new HttpError(400, 'Persona non valida.');
  if (!DAY_RE.test(day || '')) throw new HttpError(400, 'Giorno non valido.');
  if (!TIME_RE.test(time || '')) throw new HttpError(400, 'Orario non valido: usa il formato 07:30.');

  const { rows: [prev] } = await pool.query('SELECT time FROM wake_times WHERE person = $1 AND day = $2', [person, day]);
  await pool.query(
    `INSERT INTO wake_times (person, day, time) VALUES ($1, $2, $3)
     ON CONFLICT (person, day) DO UPDATE SET time = EXCLUDED.time, updated_at = now()`,
    [person, day, time]
  );
  res.json({ person, day, time });

  if (prev?.time === time) return;
  const body = prev
    ? `${person} ora si sveglia alle ${time} ${dayLabel(day)} (prima ${prev.time}).`
    : `${person} si sveglia alle ${time} ${dayLabel(day)}.`;
  notifyOthers(person, { title: `⏰ Sveglia di ${person}`, body, tag: `wake-${person}-${day}`, url: '/#sveglia' })
    .catch((err) => console.error(err));
}));

app.put('/api/wake/bulk', wrap(async (req, res) => {
  const { person, time } = req.body;
  const days = [...new Set(Array.isArray(req.body.days) ? req.body.days : [])].sort();
  if (!isPerson(person)) throw new HttpError(400, 'Persona non valida.');
  if (!days.length || days.length > 70 || !days.every((d) => DAY_RE.test(d))) throw new HttpError(400, 'Giorni non validi.');
  if (!TIME_RE.test(time || '')) throw new HttpError(400, 'Orario non valido: usa il formato 07:30.');

  const { rows: prev } = await pool.query(
    'SELECT day, time FROM wake_times WHERE person = $1 AND day = ANY($2::date[])', [person, days]
  );
  await pool.query(
    `INSERT INTO wake_times (person, day, time) SELECT $1, d, $3 FROM unnest($2::date[]) AS d
     ON CONFLICT (person, day) DO UPDATE SET time = EXCLUDED.time, updated_at = now()`,
    [person, days, time]
  );
  res.json({ person, days, time });

  const changed = days.filter((d) => prev.find((p) => p.day === d)?.time !== time);
  if (!changed.length) return;
  let body;
  if (changed.length === 1) {
    const before = prev.find((p) => p.day === changed[0]);
    body = before
      ? `${person} ora si sveglia alle ${time} ${dayLabel(changed[0])} (prima ${before.time}).`
      : `${person} si sveglia alle ${time} ${dayLabel(changed[0])}.`;
  } else {
    body = `${person} si sveglia alle ${time} per ${changed.length} giorni, da ${dayLabel(changed[0])} a ${dayLabel(changed[changed.length - 1])}.`;
  }
  notifyOthers(person, { title: `⏰ Sveglia di ${person}`, body, tag: `wake-${person}-${changed[0]}`, url: '/#sveglia' })
    .catch((err) => console.error(err));
}));

app.delete('/api/wake', wrap(async (req, res) => {
  const { person, day } = req.body;
  if (!isPerson(person) || !DAY_RE.test(day || '')) throw new HttpError(400, 'Richiesta non valida.');
  await pool.query('DELETE FROM wake_times WHERE person = $1 AND day = $2', [person, day]);
  res.json({ ok: true });
}));

// --- Spesa ---
app.get('/api/shopping', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shopping_items ORDER BY done, created_at DESC');
  res.json(rows);
}));

app.post('/api/shopping', wrap(async (req, res) => {
  const { person } = req.body;
  const name = (req.body.name || '').toString().trim().slice(0, 80);
  const qty = (req.body.qty || '').toString().trim().slice(0, 30) || null;
  if (!isPerson(person)) throw new HttpError(400, 'Persona non valida.');
  if (!name) throw new HttpError(400, 'Scrivi cosa manca.');

  // Se c'è già (anche già preso), lo rimette in lista invece di creare un doppione
  const { rows: [existing] } = await pool.query(
    'SELECT * FROM shopping_items WHERE lower(name) = lower($1) ORDER BY done LIMIT 1', [name]
  );
  if (existing && !existing.done) throw new HttpError(409, `${existing.name} è già nella lista.`);
  if (existing) {
    const { rows } = await pool.query(
      `UPDATE shopping_items SET done = false, done_by = NULL, done_at = NULL, qty = $1, added_by = $2, created_at = now()
       WHERE id = $3 RETURNING *`, [qty, person, existing.id]
    );
    return res.json(rows[0]);
  }
  const { rows } = await pool.query(
    'INSERT INTO shopping_items (name, qty, added_by) VALUES ($1, $2, $3) RETURNING *', [name, qty, person]
  );
  res.status(201).json(rows[0]);
}));

app.patch('/api/shopping/:id', wrap(async (req, res) => {
  const { person, done } = req.body;
  if (!isPerson(person)) throw new HttpError(400, 'Persona non valida.');
  const { rows } = await pool.query(
    `UPDATE shopping_items SET done = $1, done_by = CASE WHEN $1 THEN $2 ELSE NULL END,
       done_at = CASE WHEN $1 THEN now() ELSE NULL END
     WHERE id = $3 RETURNING *`,
    [Boolean(done), person, req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Questa voce non c’è più.');
  res.json(rows[0]);
}));

app.delete('/api/shopping/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM shopping_items WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/shopping/clear-done', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM shopping_items WHERE done');
  res.json({ removed: rowCount });
}));

// --- Push ---
app.get('/api/push/key', (req, res) => res.json({ key: vapidPublicKey }));

app.post('/api/push/subscribe', wrap(async (req, res) => {
  const { person, subscription } = req.body;
  if (!isPerson(person)) throw new HttpError(400, 'Persona non valida.');
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new HttpError(400, 'Iscrizione alle notifiche non valida.');
  }
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, person, data) VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET person = EXCLUDED.person, data = EXCLUDED.data`,
    [subscription.endpoint, person, subscription]
  );
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', wrap(async (req, res) => {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [req.body.endpoint || '']);
  res.json({ ok: true });
}));

app.post('/api/push/test', wrap(async (req, res) => {
  const { endpoint } = req.body;
  const { rows: [r] } = await pool.query('SELECT data FROM push_subscriptions WHERE endpoint = $1', [endpoint || '']);
  if (!r) throw new HttpError(404, 'Questo dispositivo non è iscritto alle notifiche.');
  await webpush.sendNotification(r.data, JSON.stringify({ title: 'Notifiche attive', body: 'Riceverai un avviso quando le altre indicano la sveglia.', url: '/#sveglia' }));
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Turni di casa in ascolto sulla porta ${PORT}`)))
  .catch((err) => { console.error('Errore di avvio:', err); process.exit(1); });
