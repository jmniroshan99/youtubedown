begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'dark' check(theme in ('light','dark')),
  language text not null default 'en' check(language in ('en','si')),
  updated_at timestamptz not null default now()
);
create table public.video_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  domains text[] not null,
  adapter_key text not null default 'yt_dlp' check(adapter_key in ('yt_dlp','generic','direct')),
  enabled boolean not null default true,
  support_status text not null default 'untested' check(support_status in ('available','untested','temporarily_unavailable','unsupported','disabled')),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.user_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  job_count integer not null default 0,
  primary key(user_id, day)
);
alter table public.user_daily_usage enable row level security;
revoke all on public.user_daily_usage from anon, authenticated;
grant all on public.user_daily_usage to service_role;
create table public.download_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null check(length(source_url) <= 4096),
  title text not null,
  platform text not null,
  format_spec jsonb not null,
  selected_format text not null,
  status text not null default 'queued' check(status in ('queued','downloading','processing','uploading','completed','failed','cancelled','expired')),
  progress numeric check(progress between 0 and 100),
  speed numeric,
  eta numeric,
  file_size bigint,
  storage_path text,
  error_code text,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  unique(user_id, idempotency_key),
  unique(id, user_id)
);
create table public.download_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null,
  user_id uuid not null,
  stage text not null,
  message text not null,
  created_at timestamptz not null default now(),
  foreign key(job_id,user_id) references public.download_jobs(id,user_id) on delete cascade
);
create index jobs_owner_created on public.download_jobs(user_id,created_at desc);
create index jobs_cleanup on public.download_jobs(status,expires_at);
create index jobs_recovery on public.download_jobs(status,updated_at);
create index events_owner on public.download_job_events(user_id,job_id);

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.download_jobs enable row level security;
alter table public.download_job_events enable row level security;
alter table public.video_providers enable row level security;

revoke all on public.profiles, public.user_settings, public.download_jobs, public.download_job_events, public.video_providers from anon, authenticated;
grant select, insert, update on public.profiles, public.user_settings to authenticated;
grant select on public.download_jobs, public.download_job_events, public.video_providers to authenticated;
grant all on public.profiles, public.user_settings, public.download_jobs, public.download_job_events, public.video_providers to service_role;
grant usage, select on sequence public.download_job_events_id_seq to service_role;

create policy profiles_read on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_add on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_edit on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy settings_read on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy settings_add on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy settings_edit on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy jobs_read on public.download_jobs for select to authenticated using ((select auth.uid()) = user_id);
create policy events_read on public.download_job_events for select to authenticated using ((select auth.uid()) = user_id);
create policy providers_read on public.video_providers for select to authenticated using (true);

-- Invoker function callable ONLY by trusted backend credentials. The backend supplies the verified user ID.
create function public.reserve_download(p_user_id uuid, p_source_url text, p_title text, p_platform text,
  p_format_spec jsonb, p_key uuid, p_max_active integer, p_daily_limit integer)
returns setof public.download_jobs language plpgsql security invoker set search_path = public, pg_temp as $$
declare existing public.download_jobs;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select * into existing from public.download_jobs where user_id=p_user_id and idempotency_key=p_key;
  if found then return next existing; return; end if;
  if (select count(*) from public.download_jobs where user_id=p_user_id and status in ('queued','downloading','processing','uploading')) >= p_max_active
    or coalesce((select job_count from public.user_daily_usage where user_id=p_user_id and day=(now() at time zone 'UTC')::date),0) >= p_daily_limit
  then raise exception 'QUOTA_LIMIT'; end if;
  insert into public.user_daily_usage(user_id,day,job_count) values(p_user_id,(now() at time zone 'UTC')::date,1)
    on conflict(user_id,day) do update set job_count=public.user_daily_usage.job_count+1;
  return query insert into public.download_jobs(user_id,source_url,title,platform,format_spec,selected_format,idempotency_key)
    values(p_user_id,p_source_url,p_title,p_platform,p_format_spec,p_format_spec->>'label',p_key) returning *;
end;
$$;
revoke all on function public.reserve_download(uuid,text,text,text,jsonb,uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.reserve_download(uuid,text,text,text,jsonb,uuid,integer,integer) to service_role;

insert into public.video_providers(name,domains) values
 ('YouTube',array['youtube.com','youtu.be']),('Vimeo',array['vimeo.com']),
 ('TikTok',array['tiktok.com']),('Instagram',array['instagram.com']),
 ('Facebook',array['facebook.com','fb.watch']),('X',array['x.com','twitter.com']),
 ('Dailymotion',array['dailymotion.com','dai.ly']),('Reddit',array['reddit.com','redd.it']);

insert into storage.buckets(id,name,public,file_size_limit)
 values('downloads','downloads',false,524288000)
 on conflict(id) do update set public=false;
-- No browser storage INSERT/SELECT policies: authenticated API issues expiring links after ownership checks.
-- Service credentials alone upload/delete/sign objects. Existing unrelated bucket policies are preserved.

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='download_jobs') then
    alter publication supabase_realtime add table public.download_jobs;
  end if;
end $$;
commit;
