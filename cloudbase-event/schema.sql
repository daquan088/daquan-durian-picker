create table if not exists public.durian_devices (
  device_hash text primary key check (device_hash ~ '^[a-f0-9]{64}$'),
  used_count integer not null default 0 check (used_count between 0 and 5),
  updated_at timestamptz not null default now()
);

create table if not exists public.durian_ip_daily (
  usage_day date not null,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  used_count integer not null default 0 check (used_count between 0 and 50),
  updated_at timestamptz not null default now(),
  primary key (usage_day, ip_hash)
);

create table if not exists public.durian_tasks (
  task_hash text primary key check (task_hash ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('active', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.durian_operations (
  kind text not null check (kind in ('overview', 'candidate')),
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  lease_id uuid not null,
  state text not null check (state in ('processing', 'committed')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (kind, key_hash)
);

create or replace function public.durian_quota(p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_payload text;
  v_lease uuid;
  v_device text;
  v_ip text;
  v_task text;
  v_used integer;
  v_op public.durian_operations%rowtype;
begin
  if p_action = 'get_remaining' then
    v_device := p_payload->>'device_hash';
    if v_device is null or v_device !~ '^[a-f0-9]{64}$' then raise exception 'DURIAN_INVALID_REQUEST'; end if;
    select used_count into v_used from public.durian_devices where device_hash = v_device;
    return jsonb_build_object('remaining', 5 - coalesce(v_used, 0));
  end if;

  if p_action in ('begin_overview', 'release_overview', 'commit_overview') then
    v_key := p_payload->>'key_hash';
  elsif p_action in ('begin_candidate', 'release_candidate', 'complete_candidate') then
    v_key := p_payload->>'task_hash';
  else
    raise exception 'DURIAN_INVALID_REQUEST';
  end if;
  v_payload := p_payload->>'payload_hash';
  begin v_lease := (p_payload->>'lease_id')::uuid; exception when others then raise exception 'DURIAN_INVALID_REQUEST'; end;
  if v_key is null or v_key !~ '^[a-f0-9]{64}$' or v_payload is null or v_payload !~ '^[a-f0-9]{64}$' then
    raise exception 'DURIAN_INVALID_REQUEST';
  end if;

  if p_action in ('begin_overview', 'begin_candidate') then
    if p_action = 'begin_candidate' and not exists (
      select 1 from public.durian_tasks where task_hash = v_key and state = 'active'
    ) then raise exception 'DURIAN_OPERATION_CONFLICT'; end if;
    delete from public.durian_operations
      where kind = case when p_action = 'begin_overview' then 'overview' else 'candidate' end
        and key_hash = v_key and state = 'processing' and expires_at < now();
    begin
      insert into public.durian_operations(kind, key_hash, payload_hash, lease_id, state, expires_at)
      values (case when p_action = 'begin_overview' then 'overview' else 'candidate' end,
              v_key, v_payload, v_lease, 'processing', now() + interval '5 minutes');
    exception when unique_violation then
      raise exception 'DURIAN_OPERATION_CONFLICT';
    end;
    return jsonb_build_object('ok', true);
  end if;

  if p_action in ('release_overview', 'release_candidate') then
    delete from public.durian_operations
      where kind = case when p_action = 'release_overview' then 'overview' else 'candidate' end
        and key_hash = v_key and payload_hash = v_payload and lease_id = v_lease and state = 'processing';
    return jsonb_build_object('ok', true);
  end if;

  select * into v_op from public.durian_operations
    where kind = case when p_action = 'commit_overview' then 'overview' else 'candidate' end
      and key_hash = v_key for update;
  if not found or v_op.state <> 'processing' or v_op.payload_hash <> v_payload or v_op.lease_id <> v_lease or v_op.expires_at < now() then
    raise exception 'DURIAN_OPERATION_CONFLICT';
  end if;

  if p_action = 'commit_overview' then
    v_device := p_payload->>'device_hash'; v_ip := p_payload->>'ip_hash'; v_task := p_payload->>'task_hash';
    if v_device !~ '^[a-f0-9]{64}$' or v_ip !~ '^[a-f0-9]{64}$' or v_task !~ '^[a-f0-9]{64}$' then
      raise exception 'DURIAN_INVALID_REQUEST';
    end if;
    insert into public.durian_devices(device_hash) values (v_device) on conflict do nothing;
    select used_count into v_used from public.durian_devices where device_hash = v_device for update;
    if v_used >= 5 then raise exception 'DURIAN_QUOTA_EXHAUSTED'; end if;
    insert into public.durian_ip_daily(usage_day, ip_hash) values (current_date, v_ip) on conflict do nothing;
    select used_count into v_used from public.durian_ip_daily where usage_day = current_date and ip_hash = v_ip for update;
    if v_used >= 50 then raise exception 'DURIAN_IP_RATE_LIMIT'; end if;
    update public.durian_devices set used_count = used_count + 1, updated_at = now() where device_hash = v_device returning used_count into v_used;
    update public.durian_ip_daily set used_count = used_count + 1, updated_at = now() where usage_day = current_date and ip_hash = v_ip;
    insert into public.durian_tasks(task_hash, state) values (v_task, 'active');
    update public.durian_operations set state = 'committed', expires_at = now() + interval '2 days', updated_at = now()
      where kind = 'overview' and key_hash = v_key;
    delete from public.durian_ip_daily where usage_day < current_date - 2;
    return jsonb_build_object('remaining', 5 - v_used);
  end if;

  update public.durian_tasks set state = 'completed', updated_at = now() where task_hash = v_key and state = 'active';
  if not found then raise exception 'DURIAN_OPERATION_CONFLICT'; end if;
  update public.durian_operations set state = 'committed', expires_at = now() + interval '2 days', updated_at = now()
    where kind = 'candidate' and key_hash = v_key;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.durian_quota(text, jsonb) from public;
grant execute on function public.durian_quota(text, jsonb) to public;
