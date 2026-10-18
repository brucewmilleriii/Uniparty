-- Bills and resolutions from the Congress.gov API, and which members sponsor or
-- cosponsor them. Like every table here, rows carry source_url and fetched_at.

create table if not exists bills (
  id                 text primary key,     -- 119-s-5285
  congress           integer not null,
  type               text not null,        -- HR, S, HRES, SRES, HJRES, SJRES, HCONRES, SCONRES
  number             integer not null,
  label              text not null,        -- S. 5285
  title              text not null,
  policy_area        text,
  latest_action_date date,
  latest_action_text text,
  page_url           text not null,
  source_url         text not null,
  fetched_at         timestamptz not null
);

-- No foreign key to members: bills by people who have since left office are kept.
create table if not exists member_bills (
  bioguide_id text not null,
  bill_id     text not null references bills (id) on delete cascade,
  role        text not null check (role in ('sponsor', 'cosponsor')),
  link_date   date not null,               -- introduced (sponsor) or signed on (cosponsor)
  primary key (bioguide_id, bill_id, role)
);
create index if not exists member_bills_recent_idx on member_bills (bioguide_id, role, link_date desc);

-- Per-member totals for a Congress, with the API pages they were read from.
create table if not exists member_bill_counts (
  bioguide_id       text not null,
  congress          integer not null,
  sponsored_count   integer not null,
  cosponsored_count integer not null,
  source_files      jsonb not null,        -- [{url, sha256}]
  fetched_at        timestamptz not null,
  primary key (bioguide_id, congress)
);

alter table bills enable row level security;
alter table member_bills enable row level security;
alter table member_bill_counts enable row level security;
create policy "public read bills" on bills for select using (true);
create policy "public read member bills" on member_bills for select using (true);
create policy "public read member bill counts" on member_bill_counts for select using (true);
