begin;

alter table public.leads add column activity jsonb not null default '[]'
  check (jsonb_typeof(activity) = 'array' and jsonb_array_length(activity) <= 100);

-- Runs inside the lead write: no extra table, privileged client, or second write.
-- History contains field names/status/date transitions, never note/contact values.
create function public.manage_lead_changes() returns trigger
language plpgsql set search_path = '' as $$
declare
  changed_fields jsonb;
  invalidated boolean;
  event jsonb;
begin
  if tg_op = 'INSERT' then
    new.activity = '[]'::jsonb;
    return new;
  end if;
  select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into changed_fields
  from jsonb_each(to_jsonb(new))
  where key = any(array['business_name','niche','country','city','address','phone','website','domain','email','socials','rating','review_count','source','source_id','provenance','notes','status','follow_up_at'])
    and value is distinct from to_jsonb(old)->key;
  invalidated = row(new.business_name,new.niche,new.country,new.city,new.address,new.phone,new.website,new.domain,new.email,new.socials,new.rating,new.review_count,new.source,new.source_id,new.provenance)
    is distinct from row(old.business_name,old.niche,old.country,old.city,old.address,old.phone,old.website,old.domain,old.email,old.socials,old.rating,old.review_count,old.source,old.source_id,old.provenance);
  if invalidated then
    new.audit = null;
    new.classification = null;
    new.score = null;
    new.score_reasons = '[]'::jsonb;
  end if;
  -- Client-supplied history cannot replace or forge the existing trail.
  new.activity = old.activity;
  if jsonb_array_length(changed_fields) > 0 or new.audit is distinct from old.audit then
    event = jsonb_build_object('at', now(), 'fields', changed_fields,
      'assessmentInvalidated', invalidated,
      'auditCompleted', not invalidated and new.audit is not null and new.audit is distinct from old.audit);
    if new.status is distinct from old.status then
      event = event || jsonb_build_object('statusFrom',old.status,'statusTo',new.status);
    end if;
    if new.follow_up_at is distinct from old.follow_up_at then
      event = event || jsonb_build_object('followUpFrom',old.follow_up_at,'followUpTo',new.follow_up_at);
    end if;
    select coalesce(jsonb_agg(value order by ord), '[]'::jsonb) into new.activity
    from jsonb_array_elements(old.activity || jsonb_build_array(event)) with ordinality as entries(value,ord)
    where ord > greatest(jsonb_array_length(old.activity) + 1 - 100, 0);
  end if;
  return new;
end;
$$;
revoke all on function public.manage_lead_changes() from public, anon, authenticated;
create trigger leads_management before insert or update on public.leads
for each row execute function public.manage_lead_changes();

commit;
