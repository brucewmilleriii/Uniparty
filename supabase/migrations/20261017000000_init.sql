-- Uniparty initial schema: roster, committee seats and an ingest log.
-- Every row carries source_url and fetched_at so the app can show where a fact
-- came from and how current it is.

create table if not exists members (
  bioguide_id   text primary key,
  name          text not null,
  last_name     text not null,
  chamber       text not null check (chamber in ('senate', 'house')),
  state         text not null,
  district      integer,
  party         text not null check (party in ('D', 'R', 'I')),
  party_name    text not null,
  serving_since text not null,
  term_start    date not null,
  term_end      date not null,
  phone         text,
  website       text,
  office        text,
  birthday      date,
  fec_ids       text[] not null default '{}',
  in_office     boolean not null default true,
  source_url    text not null,
  fetched_at    timestamptz not null,
  updated_at    timestamptz not null default now()
);
create index if not exists members_state_idx on members (state);

create table if not exists committee_seats (
  bioguide_id    text not null references members (bioguide_id) on delete cascade,
  committee_id   text not null,
  committee_name text not null,
  title          text,
  source_url     text not null,
  fetched_at     timestamptz not null,
  primary key (bioguide_id, committee_id)
);

create table if not exists ingest_runs (
  id           bigint generated always as identity primary key,
  source       text not null,
  fetched_at   timestamptz not null,
  status       text not null check (status in ('ok', 'failed')),
  record_count integer,
  source_files jsonb,
  error        text,
  created_at   timestamptz not null default now()
);
create index if not exists ingest_runs_source_idx on ingest_runs (source, created_at desc);

-- Public, read-only access for the website; writes go through the service role.
alter table members enable row level security;
alter table committee_seats enable row level security;
alter table ingest_runs enable row level security;
create policy "public read members" on members for select using (true);
create policy "public read committee seats" on committee_seats for select using (true);
create policy "public read ingest runs" on ingest_runs for select using (true);
