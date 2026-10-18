-- Campaign committee totals from the FEC API, one row per candidate per two-year
-- cycle. Like every table here, rows carry source_url and fetched_at.

-- No foreign key to members: campaigns of people who have since left office are kept.
create table if not exists campaign_totals (
  candidate_id             text not null,         -- FEC candidate id, H… or S…
  cycle                    integer not null,      -- 2026 = 2025–26
  bioguide_id              text not null,
  office                   text not null check (office in ('H', 'S')),
  election_year            integer,
  coverage_start           date not null,
  coverage_end             date not null,
  last_report              text,
  receipts                 numeric(14, 2) not null,
  disbursements            numeric(14, 2) not null,
  cash_on_hand             numeric(14, 2) not null,
  debts                    numeric(14, 2) not null,
  individual_itemized      numeric(14, 2) not null,
  individual_unitemized    numeric(14, 2) not null,
  party_committees         numeric(14, 2) not null,
  other_committees         numeric(14, 2) not null,
  candidate_contributions  numeric(14, 2) not null,
  candidate_loans          numeric(14, 2) not null,
  other_loans              numeric(14, 2) not null,
  transfers_in             numeric(14, 2) not null,
  other_receipts           numeric(14, 2) not null,
  page_url                 text not null,
  source_url               text not null,
  sha256                   text not null,
  fetched_at               timestamptz not null,
  primary key (candidate_id, cycle)
);
create index if not exists campaign_totals_member_idx on campaign_totals (bioguide_id, cycle);

-- Which members, and which of their candidate ids, each cycle's latest pull asked about,
-- so a member with no rows can be told apart from one the pull never reached (sworn in
-- since, or linked to a new campaign since).
create table if not exists finance_coverage (
  bioguide_id   text not null,
  cycle         integer not null,
  candidate_ids text[] not null,
  fetched_at    timestamptz not null,
  primary key (bioguide_id, cycle)
);

alter table campaign_totals enable row level security;
alter table finance_coverage enable row level security;
create policy "public read campaign totals" on campaign_totals for select using (true);
create policy "public read finance coverage" on finance_coverage for select using (true);
