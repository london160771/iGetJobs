begin;

alter table public.leads add column contact_enrichment jsonb
  check (contact_enrichment is null or (jsonb_typeof(contact_enrichment) = 'object' and octet_length(contact_enrichment::text) <= 2000));

-- Executes after leads_management, still inside the same owner write.
-- Preserve written text, but revoke approval whenever evidence/assessment changes.
create function public.guard_outreach_changes() returns trigger
language plpgsql set search_path = '' as $$
declare invalidated boolean; event jsonb;
begin
  invalidated = row(new.business_name,new.niche,new.country,new.city,new.address,new.phone,new.website,new.domain,new.email,new.socials,new.rating,new.review_count,new.source,new.source_id,new.provenance,new.audit,new.classification,new.score,new.score_reasons)
    is distinct from row(old.business_name,old.niche,old.country,old.city,old.address,old.phone,old.website,old.domain,old.email,old.socials,old.rating,old.review_count,old.source,old.source_id,old.provenance,old.audit,old.classification,old.score,old.score_reasons);
  if invalidated and old.outreach_draft is not null then
    new.outreach_draft = old.outreach_draft || '{"stale":true,"approval":"pending"}'::jsonb;
  end if;
  if new.outreach_draft is distinct from old.outreach_draft or new.contact_enrichment is distinct from old.contact_enrichment then
    event = jsonb_build_object('at',now(),'fields',to_jsonb(array_remove(array[
      case when new.outreach_draft is distinct from old.outreach_draft then 'outreach_draft' end,
      case when new.contact_enrichment is distinct from old.contact_enrichment then 'contact_enrichment' end],null)),
      'assessmentInvalidated',false,'auditCompleted',false);
    select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into new.activity
    from jsonb_array_elements(new.activity || jsonb_build_array(event)) with ordinality as entries(value,ord)
    where ord > greatest(jsonb_array_length(new.activity) + 1 - 100,0);
  end if;
  return new;
end;
$$;
revoke all on function public.guard_outreach_changes() from public,anon,authenticated;
create trigger leads_outreach before update on public.leads for each row execute function public.guard_outreach_changes();

create function public.lead_outreach_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(collection) order by collection.id),'[]'::jsonb) from (
    select id,business_name,niche,country,city,address,phone,email,website,domain,classification,score,status,source,source_id,
      created_at,updated_at,follow_up_at,audit,outreach_draft
    from public.leads where owner_id = (select auth.uid()) order by id limit 2001
  ) as collection;
$$;
revoke all on function public.lead_outreach_snapshot() from public,anon,authenticated;
grant execute on function public.lead_outreach_snapshot() to authenticated;
commit;
