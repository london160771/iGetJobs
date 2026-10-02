begin;

-- One statement / MVCC snapshot, unaffected by inserts between HTTP pages.
-- Aggregate into one scalar so PostgREST's row cap cannot truncate the collection.
-- No owner argument, privileged execution, or persistent snapshot/cache is needed.
create function public.lead_management_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(collection) order by collection.id), '[]'::jsonb)
  from (
    select id,business_name,niche,country,city,address,phone,email,website,domain,
      classification,score,status,source,source_id,created_at,updated_at,follow_up_at,
      case when audit is null then null else jsonb_build_object('scoring', audit->'scoring') end as audit
    from public.leads
    where owner_id = (select auth.uid())
    order by id
    limit 2001
  ) as collection;
$$;
revoke all on function public.lead_management_snapshot() from public, anon, authenticated;
grant execute on function public.lead_management_snapshot() to authenticated;

commit;
