import pg from 'pg';

const { Pool } = pg;
let pool;

export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export async function q(text, params = []) {
  return getPool().query(text, params);
}

export async function initDb() {
  await q(`
    create table if not exists users (
      id uuid primary key,
      email text unique not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists refresh_tokens (
      token text primary key,
      user_id uuid not null references users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create table if not exists files (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      original_name text not null,
      mime_type text not null,
      size bigint not null,
      storage_path text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists sent_items (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      type text not null check (type in ('text', 'file')),
      text_content text,
      file_id uuid references files(id) on delete cascade,
      file_name text,
      mime_type text,
      size bigint,
      is_private boolean not null default false,
      created_at timestamptz not null default now()
    );

    create index if not exists sent_items_user_created_idx on sent_items(user_id, created_at desc);
    create index if not exists files_user_idx on files(user_id);
  `);
}

export async function resetDbForTests() {
  await q('drop schema public cascade; create schema public;');
  await initDb();
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
