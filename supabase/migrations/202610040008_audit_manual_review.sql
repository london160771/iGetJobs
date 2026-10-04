begin;

alter table public.leads
  add column audit_attempt_status text not null default 'NOT_AUDITED'
    check (audit_attempt_status in ('NOT_AUDITED', 'COMPLETED', 'NEEDS_MANUAL_REVIEW')),
  add column audit_attempt_reason text
    check (audit_attempt_reason is null or audit_attempt_reason in ('HTML_TOO_LARGE', 'TEXT_TOO_LARGE', 'DOM_TOO_MANY_NODES', 'DOM_TOO_DEEP', 'ANALYSIS_TIMEOUT', 'UNSUPPORTED_CONTENT', 'ACCESS_RESTRICTED', 'OTHER_UNVERIFIED')),
  add column audit_attempted_at timestamptz,
  add column audit_attempt_detail jsonb
    check (audit_attempt_detail is null or (jsonb_typeof(audit_attempt_detail) = 'object' and octet_length(audit_attempt_detail::text) <= 1024));

-- Existing deterministic assessments were completed; untouched/incomplete rows
-- retain the safe NOT_AUDITED default. updated_at is the available historical bound.
update public.leads
set audit_attempt_status = 'COMPLETED', audit_attempted_at = updated_at
where audit is not null and classification is not null and score is not null;

alter table public.leads add constraint leads_audit_attempt_state_consistent check (
  (audit_attempt_status = 'NOT_AUDITED' and audit_attempt_reason is null and audit_attempted_at is null and audit_attempt_detail is null)
  or (audit_attempt_status = 'COMPLETED' and audit_attempt_reason is null and audit_attempted_at is not null and audit_attempt_detail is null
    and audit is not null and classification is not null and score is not null)
  or (audit_attempt_status = 'NEEDS_MANUAL_REVIEW' and audit_attempt_reason is not null and audit_attempted_at is not null)
);

-- Evidence edits clear both the old assessment and its attempt state atomically.
create or replace function public.manage_lead_changes() returns trigger
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
  where key = any(array['business_name','niche','country','city','address','phone','website','domain','email','socials','rating','review_count','source','source_id','provenance','notes','status','follow_up_at','audit_attempt_status','audit_attempt_reason','audit_attempted_at','audit_attempt_detail'])
    and value is distinct from to_jsonb(old)->key;
  invalidated = row(new.business_name,new.niche,new.country,new.city,new.address,new.phone,new.website,new.domain,new.email,new.socials,new.rating,new.review_count,new.source,new.source_id,new.provenance)
    is distinct from row(old.business_name,old.niche,old.country,old.city,old.address,old.phone,old.website,old.domain,old.email,old.socials,old.rating,old.review_count,old.source,old.source_id,old.provenance);
  if invalidated then
    new.audit = null;
    new.classification = null;
    new.score = null;
    new.score_reasons = '[]'::jsonb;
    new.audit_attempt_status = 'NOT_AUDITED';
    new.audit_attempt_reason = null;
    new.audit_attempted_at = null;
    new.audit_attempt_detail = null;
  end if;
  new.activity = old.activity;
  if jsonb_array_length(changed_fields) > 0 or new.audit is distinct from old.audit then
    event = jsonb_build_object(
      'at', now(), 'fields', changed_fields, 'assessmentInvalidated', invalidated,
      'auditCompleted', not invalidated and new.audit_attempt_status = 'COMPLETED' and new.audit_attempted_at is distinct from old.audit_attempted_at,
      'auditAttempted', new.audit_attempt_status <> 'NOT_AUDITED' and new.audit_attempted_at is distinct from old.audit_attempted_at
    );
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

-- Keep the existing owner-filtered, security-invoker snapshot and include only
-- bounded attempt status/reason metadata needed by filters and compact list rows.
create or replace function public.lead_management_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(collection) order by collection.id), '[]'::jsonb)
  from (
    select id,business_name,niche,country,city,address,phone,email,website,domain,
      classification,audit_attempt_status,audit_attempt_reason,audit_attempted_at,score,status,source,source_id,
      created_at,updated_at,follow_up_at,
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
