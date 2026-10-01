import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const denied = (error: unknown) => error instanceof Error && 'code' in error && error.code === '42501';

test('prerequisite migration enforces PostgreSQL owner isolation for both tables', async () => {
  const db = new PGlite();
  try {
    // Emulate only Supabase's roles/Auth identity function; run the actual migration unchanged.
    await db.exec(`
      create role anon noinherit;
      create role authenticated noinherit;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema auth to anon, authenticated;
    `);
    await db.query('insert into auth.users (id) values ($1), ($2)', [userA, userB]);
    await db.exec(await readFile(new URL('../supabase/migrations/202610010001_auth_and_leads.sql', import.meta.url), 'utf8'));
    const security = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid in ('public.leads'::regclass, 'public.user_settings'::regclass)"
    );
    assert.equal(security.rows.length, 2);
    assert.ok(security.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));

    async function asUser(id: string) {
      await db.exec('reset role; set role authenticated');
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    }
    for (const table of ['leads', 'user_settings']) {
      const ownIds: string[] = [];
      for (const owner of [userA, userB]) {
        await asUser(owner);
        const insert = await db.query<{ id: string; owner_id: string }>(table === 'leads'
          ? "insert into public.leads (business_name, source) values ('RLS test', 'CSV') returning id, owner_id"
          : 'insert into public.user_settings default values returning id, owner_id');
        assert.equal(insert.rows[0]?.owner_id, owner);
        ownIds.push(insert.rows[0]!.id);
        const ownRead = await db.query(`select id from public.${table}`);
        assert.equal(ownRead.rows.length, 1);
        const ownUpdate = await db.query(`update public.${table} set updated_at = now() where id = $1 returning id`, [ownIds.at(-1)]);
        assert.equal(ownUpdate.rows.length, 1);
      }
      for (let i = 0; i < 2; i++) {
        const owner = i === 0 ? userA : userB;
        const foreignOwner = i === 0 ? userB : userA;
        await asUser(owner);
        const foreignId = ownIds[1 - i];
        assert.equal((await db.query(`select id from public.${table} where id = $1`, [foreignId])).rows.length, 0);
        assert.equal((await db.query(`update public.${table} set updated_at = now() where id = $1 returning id`, [foreignId])).rows.length, 0);
        assert.equal((await db.query(`delete from public.${table} where id = $1 returning id`, [foreignId])).rows.length, 0);
        await assert.rejects(db.query(`update public.${table} set owner_id = $1 where id = $2`, [foreignOwner, ownIds[i]]), denied);
        await assert.rejects(db.query(table === 'leads'
          ? "insert into public.leads (owner_id, business_name, source) values ($1, 'Forged owner', 'CSV')"
          : 'insert into public.user_settings (owner_id) values ($1)', [foreignOwner]), denied);
        // Verify failed writes did not remove or transfer either user's record.
        assert.equal((await db.query(`select id from public.${table} where id = $1`, [ownIds[i]])).rows.length, 1);
      }
      await db.exec('reset role; set role anon');
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
      await assert.rejects(db.query(`select id from public.${table}`), denied);
      await assert.rejects(db.query(table === 'leads'
        ? "insert into public.leads (owner_id, business_name, source) values ($1, 'Anonymous', 'CSV')"
        : 'insert into public.user_settings (owner_id) values ($1)', [userA]), denied);
      for (let i = 0; i < 2; i++) {
        await asUser(i === 0 ? userA : userB);
        assert.equal((await db.query(`delete from public.${table} where id = $1 returning id`, [ownIds[i]])).rows.length, 1);
      }
    }
  } finally { await db.close(); }
});
