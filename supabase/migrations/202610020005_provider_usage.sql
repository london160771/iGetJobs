begin;

-- Global provider-account quota, not user-owned lead/contact data.
create table public.provider_usage (
  provider text primary key check (provider in ('OSM','SERPAPI','HUNTER')),
  period text not null,
  count integer not null check (count >= 0),
  last_call timestamptz
);
alter table public.provider_usage enable row level security;
alter table public.provider_usage force row level security;
revoke all on public.provider_usage from public, anon, authenticated, service_role;

create function public.reserve_provider_usage(p_provider text, p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare reservation_time timestamptz; current_period text; previous public.provider_usage%rowtype; cap integer; cooldown interval;
begin
  cap = case p_provider when 'OSM' then 30 when 'SERPAPI' then 1000 when 'HUNTER' then 50 end;
  if cap is null or p_limit is null or p_limit < 1 or p_limit > cap then raise exception 'QUOTA_CONFIGURATION'; end if;
  insert into public.provider_usage(provider,period,count) values (p_provider,'',0) on conflict do nothing;
  select * into previous from public.provider_usage where provider = p_provider for update;
  -- Database clock after row lock: callers cannot choose/reset periods or timers.
  reservation_time = clock_timestamp();
  current_period = to_char(reservation_time at time zone 'UTC',case when p_provider = 'OSM' then 'YYYY-MM-DD' else 'YYYY-MM' end);
  cooldown = case when p_provider = 'OSM' then interval '15 seconds' else interval '5 seconds' end;
  if previous.last_call is not null and reservation_time - previous.last_call < cooldown then raise exception 'QUOTA_COOLDOWN'; end if;
  if previous.period <> current_period then previous.count = 0; end if;
  if previous.count >= p_limit then raise exception 'QUOTA_EXHAUSTED'; end if;
  update public.provider_usage set period=current_period,count=previous.count+1,last_call=reservation_time where provider=p_provider;
  return jsonb_build_object('period',current_period,'count',previous.count+1,'lastCall',floor(extract(epoch from reservation_time)*1000));
end;
$$;
create function public.provider_usage_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(provider,jsonb_build_object('period',period,'count',count,'lastCall',coalesce(floor(extract(epoch from last_call)*1000),0))),'{}'::jsonb) from public.provider_usage;
$$;
revoke all on function public.reserve_provider_usage(text,integer), public.provider_usage_status() from public,anon,authenticated,service_role;
grant execute on function public.reserve_provider_usage(text,integer), public.provider_usage_status() to service_role;
commit;
