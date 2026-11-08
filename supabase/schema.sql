-- Jarvis database. Run once in the Supabase SQL editor.
-- Every table has row-level security ON and no policies: only the
-- server-side service-role key can read or write. The public anon key
-- gets nothing.

create extension if not exists pgcrypto;

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- One row per connected inbox. refresh_token_enc is AES-256-GCM
-- ciphertext; the key lives only in Vercel (TOKEN_ENCRYPTION_KEY).
create table if not exists accounts (
  id text primary key check (id in ('personal', 'realestate', 'dynamic')),
  provider text not null check (provider in ('google', 'microsoft')),
  email text,
  refresh_token_enc text not null,
  connected_at timestamptz not null default now(),
  last_error text
);

create table if not exists processed_emails (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  message_id text not null,
  thread_id text,
  status text not null, -- processing | sent | drafted | filed | archived | dismissed | error
  attempts int not null default 1,
  from_email text,
  from_name text,
  subject text,
  received_at timestamptz,
  category text,
  priority text,
  summary text,
  reply_body text,
  reply_confidence real,
  risk_flags text[] default '{}',
  reasons text[] default '{}',
  outbound_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, message_id)
);
create index if not exists processed_emails_status_idx on processed_emails (status, updated_at desc);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  due date,
  priority text not null default 'medium',
  status text not null default 'open',
  account_id text,
  source text, -- email | chat | manual
  source_ref text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists tasks_status_idx on tasks (status, due);

create table if not exists plans (
  day date primary key,
  data jsonb not null,
  events jsonb,
  created_at timestamptz not null default now()
);

create table if not exists memory (
  id uuid primary key default gen_random_uuid(),
  fact text not null,
  created_at timestamptz not null default now()
);

create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  to_addrs text[] not null,
  cc_addrs text[] default '{}',
  subject text,
  body text not null,
  reply_to_message_id text,
  status text not null default 'pending', -- pending | sending | sent | discarded
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  ok boolean not null,
  detail jsonb,
  duration_ms int,
  created_at timestamptz not null default now()
);

create table if not exists login_failures (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists login_failures_idx on login_failures (created_at);

alter table settings enable row level security;
alter table accounts enable row level security;
alter table processed_emails enable row level security;
alter table tasks enable row level security;
alter table plans enable row level security;
alter table memory enable row level security;
alter table outbox enable row level security;
alter table runs enable row level security;
alter table login_failures enable row level security;
