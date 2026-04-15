'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const DB_SLOT_MIN = 1;
const DB_SLOT_MAX = 1;
const DEFAULT_BODY_LIMIT = '80mb';
const REQUIRED_ENV = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];

const missingEnv = REQUIRED_ENV.filter((name) => !String(process.env[name] || '').trim());
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCorsOptions() {
  const allowList = parseCsv(
    process.env.CORS_ALLOWED_ORIGIN || process.env.CORS_ALLOWED_ORIGINS || ''
  );

  return {
    origin(origin, callback) {
      // Browser extensions / curl / same-origin requests may have no origin header.
      if (!origin) return callback(null, true);
      if (!allowList.length || allowList.includes(origin)) return callback(null, true);
      return callback(new Error('CORS origin is not allowed'));
    },
    methods: ['GET', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  };
}

function buildSslConfig() {
  const mode = String(process.env.PGSSLMODE || 'require').toLowerCase();
  if (mode === 'disable') return false;

  // Azure PostgreSQL Flexible Server needs SSL by default.
  const rejectUnauthorized =
    String(process.env.PGSSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() === 'true';

  return { rejectUnauthorized };
}

function parseDbSlot(raw) {
  const slot = Number(raw);
  if (!Number.isInteger(slot)) return null;
  if (slot < DB_SLOT_MIN || slot > DB_SLOT_MAX) return null;
  return slot;
}

function parseUserId(raw) {
  const userId = String(raw ?? '').trim();
  if (!userId) return null;
  if (userId.length > 128) return null;
  return userId;
}

function parsePayload(raw) {
  return Array.isArray(raw) ? raw : null;
}

function requireApiKey(req, res, next) {
  const expectedApiKey = String(process.env.API_KEY || '').trim();
  if (!expectedApiKey) return next();

  const authHeader = String(req.get('authorization') || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== expectedApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: buildSslConfig(),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
});

const INIT_SQL = `
create table if not exists attraction_databases (
  user_id text not null,
  db_slot smallint not null check (db_slot = 1),
  payload jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, db_slot)
);

create index if not exists idx_attraction_databases_user_id
  on attraction_databases (user_id);
`;

const SINGLE_DB_MODE_SQL = `
delete from attraction_databases
where db_slot <> 1;

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select n.nspname, c.relname as table_name, con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'c'
      and c.relname = 'attraction_databases'
      and pg_get_constraintdef(con.oid) ilike '%db_slot%'
  loop
    execute format(
      'alter table %I.%I drop constraint %I',
      constraint_row.nspname,
      constraint_row.table_name,
      constraint_row.conname
    );
  end loop;

  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    where c.relname = 'attraction_databases'
      and con.conname = 'chk_attraction_databases_db_slot_only_1'
  ) then
    alter table attraction_databases
      add constraint chk_attraction_databases_db_slot_only_1
      check (db_slot = 1);
  end if;
end $$;
`;

async function ensureSchema() {
  const enabled = String(process.env.AUTO_INIT_SCHEMA || 'true').toLowerCase() !== 'false';
  if (!enabled) return;
  await pool.query(INIT_SQL);
  await pool.query(SINGLE_DB_MODE_SQL);
}

const app = express();
app.disable('x-powered-by');
app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || DEFAULT_BODY_LIMIT }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: `Payload too large. Please increase JSON_BODY_LIMIT (current: ${process.env.JSON_BODY_LIMIT || DEFAULT_BODY_LIMIT}).`,
    });
  }
  if (err && String(err.message || '').includes('CORS')) {
    return res.status(403).json({ error: 'CORS blocked this origin' });
  }
  return next(err);
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('select 1 as ok');
    return res.json({
      ok: true,
      service: 'beijing-attractions-backend',
      db: 'up',
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Health check failed:', err.message);
    return res.status(503).json({
      ok: false,
      service: 'beijing-attractions-backend',
      db: 'down',
      time: new Date().toISOString(),
    });
  }
});

app.get('/attraction-databases', requireApiKey, async (req, res) => {
  const userId = parseUserId(req.query.user_id);
  if (!userId) {
    return res.status(400).json({ error: 'user_id is required and must be <= 128 chars' });
  }

  const dbSlot = parseDbSlot(req.query.db_slot);
  if (!dbSlot) {
    return res.status(400).json({ error: 'db_slot must be 1' });
  }

  try {
    const query = `
      select payload
      from attraction_databases
      where user_id = $1 and db_slot = $2
      limit 1
    `;
    const result = await pool.query(query, [userId, dbSlot]);
    const payload = result.rows[0]?.payload;

    return res.json({ payload: Array.isArray(payload) ? payload : [] });
  } catch (err) {
    console.error('GET /attraction-databases failed:', err);
    return res.status(500).json({ error: 'Failed to load payload' });
  }
});

app.put('/attraction-databases', requireApiKey, async (req, res) => {
  const userId = parseUserId(req.body?.user_id);
  if (!userId) {
    return res.status(400).json({ error: 'user_id is required and must be <= 128 chars' });
  }

  const dbSlot = parseDbSlot(req.body?.db_slot);
  if (!dbSlot) {
    return res.status(400).json({ error: 'db_slot must be 1' });
  }

  const payload = parsePayload(req.body?.payload);
  if (!payload) {
    return res.status(400).json({ error: 'payload must be an array' });
  }

  try {
    const query = `
      insert into attraction_databases (user_id, db_slot, payload)
      values ($1, $2, $3::jsonb)
      on conflict (user_id, db_slot)
      do update
        set payload = excluded.payload,
            updated_at = now()
    `;
    await pool.query(query, [userId, dbSlot, JSON.stringify(payload)]);

    return res.status(204).send();
  } catch (err) {
    console.error('PUT /attraction-databases failed:', err);
    return res.status(500).json({ error: 'Failed to save payload' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT || 3000);
let server;

async function start() {
  try {
    await ensureSchema();
    await pool.query('select 1');

    server = app.listen(port, () => {
      console.log(`Backend is running on port ${port}`);
    });
  } catch (err) {
    console.error('Failed to start backend:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Shutdown failed:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error(err);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error(err);
    process.exit(1);
  });
});

start();
