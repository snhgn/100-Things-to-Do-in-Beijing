"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const BACKEND_ENV_PATH = path.resolve(__dirname, "../.env");
const DEFAULT_ATTRACTIONS_PATH = path.resolve(__dirname, "../../js/default-attractions.js");
const SLOT_MIN = 1;
const SLOT_MAX = 10;

dotenv.config({ path: BACKEND_ENV_PATH });

function loadDefaultChecklist() {
  if (!fs.existsSync(DEFAULT_ATTRACTIONS_PATH)) {
    throw new Error(`Default checklist file not found: ${DEFAULT_ATTRACTIONS_PATH}`);
  }

  const source = fs.readFileSync(DEFAULT_ATTRACTIONS_PATH, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: DEFAULT_ATTRACTIONS_PATH });

  const rawList = sandbox.window.DEFAULT_ATTRACTIONS;
  if (!Array.isArray(rawList) || !rawList.length) {
    throw new Error("window.DEFAULT_ATTRACTIONS is empty or invalid.");
  }

  return rawList.map((item, index) => {
    const tags = Array.isArray(item?.tags)
      ? item.tags
          .map((tag) => ({
            level: Math.max(1, Math.min(5, Number(tag?.level) || 1)),
            name: String(tag?.name || "").trim(),
          }))
          .filter((tag) => tag.name)
      : [];

    return {
      id: index + 1,
      name: String(item?.name || "未命名景点").trim() || "未命名景点",
      description: String(item?.description || "").trim(),
      tags,
      visited: false,
      visitDate: null,
      notes: "",
      photos: [],
    };
  });
}

function getPool() {
  return new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl:
      String(process.env.PGSSLMODE || "require").toLowerCase() === "disable"
        ? false
        : {
            rejectUnauthorized:
              String(process.env.PGSSL_REJECT_UNAUTHORIZED || "false").toLowerCase() ===
              "true",
          },
  });
}

async function resolveTargetUsers(pool, explicitUser) {
  const userId = String(explicitUser || "").trim();
  if (userId) return [userId];

  const result = await pool.query(
    "select distinct user_id from attraction_databases order by user_id"
  );

  if (result.rowCount > 0) return result.rows.map((row) => row.user_id);

  const fallback = String(process.env.SEED_USER_ID || "").trim() || "default-user";
  return [fallback];
}

async function seedAllSlots(pool, userIds, payload) {
  const sql = `
    insert into attraction_databases (user_id, db_slot, payload)
    values ($1, $2, $3::jsonb)
    on conflict (user_id, db_slot)
    do update
      set payload = excluded.payload,
          updated_at = now()
  `;

  for (const userId of userIds) {
    for (let slot = SLOT_MIN; slot <= SLOT_MAX; slot += 1) {
      await pool.query(sql, [userId, slot, JSON.stringify(payload)]);
    }
  }
}

async function verify(pool, userIds) {
  const result = await pool.query(
    `
      select
        user_id,
        db_slot,
        jsonb_array_length(payload) as item_count,
        updated_at
      from attraction_databases
      where user_id = any($1::text[])
      order by user_id, db_slot
    `,
    [userIds]
  );

  const grouped = new Map();
  for (const row of result.rows) {
    if (!grouped.has(row.user_id)) grouped.set(row.user_id, []);
    grouped.get(row.user_id).push({
      slot: Number(row.db_slot),
      item_count: Number(row.item_count),
      updated_at: row.updated_at,
    });
  }

  return Object.fromEntries(grouped.entries());
}

async function main() {
  const userArgIndex = process.argv.indexOf("--user");
  const explicitUser =
    userArgIndex !== -1 && userArgIndex + 1 < process.argv.length
      ? process.argv[userArgIndex + 1]
      : "";

  const payload = loadDefaultChecklist();
  const pool = getPool();

  try {
    const userIds = await resolveTargetUsers(pool, explicitUser);
    await seedAllSlots(pool, userIds, payload);
    const summary = await verify(pool, userIds);

    console.log(
      JSON.stringify(
        {
          seededUsers: userIds,
          slotRange: [SLOT_MIN, SLOT_MAX],
          defaultChecklistCount: payload.length,
          summary,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
