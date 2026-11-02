import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const db = new PGlite()
const a = '11111111-1111-4111-8111-111111111111'
const b = '22222222-2222-4222-8222-222222222222'
const k = '33333333-3333-4333-8333-333333333333'
let checks = 0
function pass(name) { checks++; process.stdout.write(`PASS ${name}\n`) }
await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key, is_anonymous boolean not null default false);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,service_role;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
 create publication supabase_realtime;
 insert into auth.users(id) values('${a}'),('${b}');
`)
await db.exec(await readFile(new URL('../supabase/migrations/20261102052707_videoflow_initial.sql', import.meta.url), 'utf8'))
pass('Full migration executes in isolated PostgreSQL')
await db.exec('set role service_role')
const args = [a,'https://example.com/video','Test video','Fixture',JSON.stringify({label:'720p MP4'}),k,2,2]
const reserve = 'select * from public.reserve_download($1::uuid,$2,$3,$4,$5::jsonb,$6::uuid,$7::integer,$8::integer)'
const first = (await db.query(reserve,args)).rows[0]
assert.equal((await db.query(reserve,args)).rows[0].id, first.id)
pass('Idempotency returns the original job')
await db.query(reserve,[b,...args.slice(1,5),'44444444-4444-4444-8444-444444444444',2,2])
await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${a}',false)`)
const mine = (await db.query('select id,user_id from public.download_jobs')).rows
assert.equal(mine.length,1); assert.equal(mine[0].user_id,a)
pass('User A cannot read user B rows under RLS')
for (const [name,sql] of [
 ['Browser cannot fake completed jobs',"update public.download_jobs set status='completed'"],
 ['Browser cannot add providers',"insert into public.video_providers(name,domains) values('Evil',array['evil.example'])"],
 ['Browser cannot reserve server jobs',`select public.reserve_download('${a}','https://example.com','x','x','{}','${k}',2,2)`],
]) {
 await assert.rejects(() => db.exec(sql), /permission denied/); pass(name)
}
await db.exec(`insert into public.user_settings(user_id,theme) values('${a}','dark'); update public.user_settings set theme='light' where user_id='${a}'`)
assert.equal((await db.query('select theme from public.user_settings')).rows[0].theme,'light')
pass('Owner can save settings')
await assert.rejects(() => db.exec(`insert into public.user_settings(user_id,theme) values('${b}','dark')`),/row-level security/)
pass('Owner cannot write another user settings')
await db.exec(`reset role; set role service_role; delete from public.download_jobs where id='${first.id}'`)
await db.query(reserve,[...args.slice(0,5),'55555555-5555-4555-8555-555555555555',2,2])
await assert.rejects(() => db.query(reserve,[...args.slice(0,5),'66666666-6666-4666-8666-666666666666',2,2]),/QUOTA_LIMIT/)
pass('Deleting history does not reset daily quota')
await db.exec('reset role')
assert.equal((await db.query("select public from storage.buckets where id='downloads'")).rows[0].public,false)
pass('Downloads bucket is private')
assert.equal((await db.query("select count(*)::int as n from pg_publication_tables where pubname='supabase_realtime' and tablename='download_jobs'")).rows[0].n,1)
pass('Realtime publication includes downloads')
const guestA = '77777777-7777-4777-8777-777777777777'
const guestB = '88888888-8888-4888-8888-888888888888'
await db.exec(`reset role; insert into auth.users(id,is_anonymous) values('${guestA}',true),('${guestB}',true); set role service_role`)
const guestArgs = [guestA,'https://example.com/guest','Guest video','Fixture',JSON.stringify({label:'MP4',_policy:{guest:true,max_bytes:104857600,max_duration:900}}),'99999999-9999-4999-8999-999999999999',1,2]
const guestJob = (await db.query(reserve,guestArgs)).rows[0]
await assert.rejects(() => db.query(reserve,[...guestArgs.slice(0,5),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,2]),/QUOTA_LIMIT/)
pass('Guest active-job limit is enforced by the reservation transaction')
await db.query(reserve,[guestB,...guestArgs.slice(1,5),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,2])
await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${guestA}',false); select set_config('request.jwt.claim.is_anonymous','true',false)`)
const guestRows = (await db.query('select id,user_id from public.download_jobs')).rows
assert.deepEqual(guestRows,[{id:guestJob.id,user_id:guestA}])
pass('Guest authenticated identity sees only its own records under existing RLS')
await assert.rejects(() => db.exec(`update public.download_jobs set user_id='${guestB}'`), /permission denied/)
await assert.rejects(() => db.exec(`select public.reserve_download('${guestA}','https://example.com','x','x','{}','${k}',999,999)`), /permission denied/)
pass('Guests cannot reassign jobs or choose their own server quotas')
await db.exec(`reset role; set role service_role; delete from public.download_jobs where id='${guestJob.id}'`)
await db.query(reserve,[...guestArgs.slice(0,5),'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,2])
await db.exec(`update public.download_jobs set status='failed' where user_id='${guestA}'`)
await assert.rejects(() => db.query(reserve,[...guestArgs.slice(0,5),'dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,2]), /QUOTA_LIMIT/)
pass('Guest daily quota survives failed jobs and history deletion')
await db.close()
console.log(`${checks} database checks passed. Supabase service APIs and production RLS remain untested.`)
