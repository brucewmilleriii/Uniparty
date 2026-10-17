-- Roll-call votes from the House Clerk and Senate.gov, and each member's position.
-- Like every table here, rows carry source_url and fetched_at, plus the SHA-256
-- of the source file they were parsed from.

alter table members add column if not exists lis_id text;

create table if not exists votes (
  id          text primary key,            -- house-2026-250, senate-119-2-256
  chamber     text not null check (chamber in ('senate', 'house')),
  congress    integer not null,
  session     integer not null,
  roll_number integer not null,
  vote_date   date not null,
  vote_time   text,
  question    text not null,
  description text not null default '',
  measure     text,
  measure_url text,
  result      text not null,
  totals      jsonb,                       -- {yea, nay, present, notVoting}, as published
  page_url    text not null,
  source_url  text not null,
  sha256      text not null,
  fetched_at  timestamptz not null
);
create index if not exists votes_recent_idx on votes (chamber, vote_date desc, roll_number desc);

-- No foreign key to members: votes cast by people who have since left office are kept.
create table if not exists vote_positions (
  vote_id     text not null references votes (id) on delete cascade,
  bioguide_id text not null,
  position    text not null,               -- as recorded: Yea, Nay, Aye, No, Present, Not Voting, ...
  primary key (vote_id, bioguide_id)
);
create index if not exists vote_positions_member_idx on vote_positions (bioguide_id);

alter table votes enable row level security;
alter table vote_positions enable row level security;
create policy "public read votes" on votes for select using (true);
create policy "public read vote positions" on vote_positions for select using (true);
