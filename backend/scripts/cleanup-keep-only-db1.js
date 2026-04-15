"use strict";

const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const BACKEND_ENV_PATH = path.resolve(__dirname, "../.env");
dotenv.config({ path: BACKEND_ENV_PATH });

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

async function getSlotDistribution(pool) {
  const result = await pool.query(
    `
      select db_slot, count(*) as row_count
      from attraction_databases
      group by db_slot
      order by db_slot
    `
  );

  return result.rows.map((row) => ({
    db_slot: Number(row.db_slot),
    row_count: Number(row.row_count),
  }));
}

async function getStorageStats(pool) {
  const result = await pool.query(
    `
      select
        pg_size_pretty(pg_total_relation_size('attraction_databases')) as table_size_pretty,
        pg_total_relation_size('attraction_databases') as table_size_bytes,
        pg_database_size(current_database()) as database_size_bytes,
        pg_size_pretty(pg_database_size(current_database())) as database_size_pretty
    `
  );
  return result.rows[0] || null;
}

async function main() {
  const pool = getPool();
  try {
    const before = await getSlotDistribution(pool);

    const deleted = await pool.query(
      "delete from attraction_databases where db_slot <> 1"
    );

    const after = await getSlotDistribution(pool);
    const storage = await getStorageStats(pool);

    console.log(
      JSON.stringify(
        {
          deletedRowsOutsideDb1: deleted.rowCount,
          before,
          after,
          storage,
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
  console.error("Cleanup failed:", error);
  process.exit(1);
});
