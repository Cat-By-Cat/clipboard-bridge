import pg from 'pg';
const { Pool } = pg;

const memory = !process.env.DATABASE_URL || process.env.DATABASE_URL === 'memory';
const mem = {
  users: [], devices: [], refreshTokens: [], clipboardEvents: [], fileTransfers: [], pairingRequests: [], chunks: new Map()
};
let pool;

export function isMemory() { return memory; }
export function getMem() { return mem; }

export async function initDb() {
  if (memory) return;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    create table if not exists users (
      id uuid primary key, email text unique not null, password_hash text not null, created_at timestamptz not null default now()
    );
    create table if not exists refresh_tokens (
      token text primary key, user_id uuid not null references users(id) on delete cascade, expires_at timestamptz not null
    );
    create table if not exists devices (
      id uuid primary key, user_id uuid not null references users(id) on delete cascade, name text not null,
      platform text not null, public_key text not null, last_seen_at timestamptz, trusted boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table if not exists clipboard_events (
      id uuid primary key, user_id uuid not null references users(id) on delete cascade, sender_device_id uuid not null,
      target_device_ids jsonb, ciphertext text not null, nonce text not null, content_hash text, created_at timestamptz not null default now()
    );
    create table if not exists file_transfers (
      id uuid primary key, upload_id uuid unique not null, user_id uuid not null references users(id) on delete cascade,
      sender_device_id uuid not null, target_device_ids jsonb not null, encrypted_metadata text not null, size bigint not null,
      chunk_size int not null, status text not null, expires_at timestamptz not null, created_at timestamptz not null default now()
    );
    create table if not exists pairing_requests (
      code text primary key, user_id uuid not null references users(id) on delete cascade, device_name text not null,
      platform text not null, public_key text not null, encrypted_key_envelope text, expires_at timestamptz not null
    );
  `);
}

export async function q(text, params=[]) {
  if (memory) throw new Error('SQL query unavailable in memory mode');
  return pool.query(text, params);
}
