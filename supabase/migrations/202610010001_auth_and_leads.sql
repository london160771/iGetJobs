begin;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  business_name text not null check (length(trim(business_name)) between 1 and 300),
  niche text,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  city text,
  address text,
  phone text,
  website text,
  domain text,
  email text,
  socials jsonb not null default '{}' check (jsonb_typeof(socials) = 'object'),
  rating numeric check (rating between 0 and 5),
  review_count integer check (review_count >= 0),
  source text not null check (source in ('SERPAPI', 'OSM', 'CSV')),
  source_id text,
  provenance jsonb not null default '[]' check (jsonb_typeof(provenance) = 'array'),
  audit jsonb,
  classification text check (classification in ('NO_WEBSITE', 'POOR_WEBSITE', 'ACCEPTABLE_WEBSITE')),
  score numeric check (score between 0 and 100),
  score_reasons jsonb not null default '[]' check (jsonb_typeof(score_reasons) = 'array'),
  outreach_draft jsonb,
  status text not null default 'New' check (status in ('New', 'Qualified', 'Contacted', 'Replied', 'Call Booked', 'Closed', 'Lost')),
  notes text not null default '',
  follow_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Non-unique comparison indexes: shared domains/phones can represent different branches.
create index leads_owner_created on public.leads (owner_id, created_at desc);
create index leads_owner_domain on public.leads (owner_id, domain) where domain is not null;
create index leads_owner_phone on public.leads (owner_id, phone) where phone is not null;

create table public.user_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique default auth.uid() references auth.users(id) on delete cascade,
  markets jsonb not null default '[]' check (jsonb_typeof(markets) = 'array'),
  niches jsonb not null default '[]' check (jsonb_typeof(niches) = 'array'),
  scoring_weights jsonb not null default '{}' check (jsonb_typeof(scoring_weights) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.set_updated_at() from public, anon, authenticated;
create trigger leads_updated_at before update on public.leads
for each row execute function public.set_updated_at();
create trigger user_settings_updated_at before update on public.user_settings
for each row execute function public.set_updated_at();

alter table public.leads enable row level security;
alter table public.leads force row level security;
alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;

revoke all on public.leads, public.user_settings from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.leads, public.user_settings to authenticated;

create policy leads_owner on public.leads for all to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);
create policy user_settings_owner on public.user_settings for all to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

commit;
