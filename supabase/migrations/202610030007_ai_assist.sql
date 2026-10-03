begin;

-- User-controlled flag. Existing owner RLS and updated_at compare-and-swap apply.
alter table public.leads add column mockup_candidate boolean not null default false;

-- Global, durable AgentRouter budget. Keep the existing locked reservation RPC;
-- successful reservations count even when a remote request later fails.
alter table public.provider_usage drop constraint provider_usage_provider_check;
alter table public.provider_usage add constraint provider_usage_provider_check
  check (provider in ('OSM','SERPAPI','HUNTER','GEOAPIFY','AGENTROUTER'));

create or replace function public.reserve_provider_usage(p_provider text, p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare reservation_time timestamptz; current_period text; previous public.provider_usage%rowtype; cap integer; cooldown interval;
begin
  cap = case p_provider when 'OSM' then 30 when 'SERPAPI' then 1000 when 'HUNTER' then 50 when 'GEOAPIFY' then 1000 when 'AGENTROUTER' then 35 end;
  if cap is null or p_limit is null or p_limit < 1 or p_limit > cap then raise exception 'QUOTA_CONFIGURATION'; end if;
  insert into public.provider_usage(provider,period,count) values (p_provider,'',0) on conflict do nothing;
  select * into previous from public.provider_usage where provider = p_provider for update;
  reservation_time = clock_timestamp();
  current_period = to_char(reservation_time at time zone 'UTC',case when p_provider in ('OSM','GEOAPIFY','AGENTROUTER') then 'YYYY-MM-DD' else 'YYYY-MM' end);
  cooldown = case when p_provider = 'OSM' then interval '15 seconds' when p_provider = 'AGENTROUTER' then interval '0 seconds' else interval '5 seconds' end;
  if previous.last_call is not null and reservation_time - previous.last_call < cooldown then raise exception 'QUOTA_COOLDOWN'; end if;
  if previous.period <> current_period then previous.count = 0; end if;
  if previous.count >= p_limit then raise exception 'QUOTA_EXHAUSTED'; end if;
  update public.provider_usage set period=current_period,count=previous.count+1,last_call=reservation_time where provider=p_provider;
  return jsonb_build_object('period',current_period,'count',previous.count+1,'lastCall',floor(extract(epoch from reservation_time)*1000));
end;
$$;
revoke all on function public.reserve_provider_usage(text,integer) from public,anon,authenticated,service_role;
grant execute on function public.reserve_provider_usage(text,integer) to service_role;

commit;
