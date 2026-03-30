create extension if not exists vector;

create table if not exists users (
  id text primary key,
  username text not null,
  display_name text not null,
  joined_at timestamptz,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  tags text[] not null default '{}',
  lead_score integer not null default 0
);

create table if not exists messages (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  username text not null,
  channel_id text not null,
  content text not null,
  created_at timestamptz not null,
  source text not null default 'discord_message'
);

alter table messages
  add column if not exists source text not null default 'discord_message';

create table if not exists leads (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  message_id text not null references messages(id) on delete cascade,
  username text not null,
  lead_score integer not null,
  reasons text[] not null default '{}',
  tags text[] not null default '{}',
  suggested_action text not null,
  created_at timestamptz not null
);

create table if not exists events (
  id text primary key,
  type text not null,
  user_id text references users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create table if not exists knowledge_chunks (
  id text primary key,
  source text not null,
  title text not null,
  content text not null,
  embedding vector(__EMBED_DIMENSIONS__),
  updated_at timestamptz not null default now()
);

create index if not exists idx_messages_created_at on messages (created_at desc);
create index if not exists idx_leads_created_at on leads (created_at desc);
create index if not exists idx_events_type_created_at on events (type, created_at desc);
create index if not exists idx_knowledge_chunks_source on knowledge_chunks (source);

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'idx_knowledge_chunks_embedding'
  ) then
    execute 'create index idx_knowledge_chunks_embedding on knowledge_chunks using hnsw (embedding vector_cosine_ops)';
  end if;
exception
  when undefined_object then
    null;
end $$;
