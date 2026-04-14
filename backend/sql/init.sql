create table if not exists attraction_databases (
  user_id text not null,
  db_slot smallint not null check (db_slot between 1 and 10),
  payload jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, db_slot)
);

create index if not exists idx_attraction_databases_user_id
  on attraction_databases (user_id);
