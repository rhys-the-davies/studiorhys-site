-- Tavern: Supabase setup
-- Run once in the Supabase dashboard: SQL Editor > New query > paste this file > Run.
-- It is safe to run again: it replaces the functions and leaves existing state alone.
-- After running it, set the table password with the statement at the bottom.
--
-- Nothing in this file is secret. The password is never written here.

-- 1. Password hashing (Supabase ships pgcrypto in the "extensions" schema)
create extension if not exists pgcrypto with schema extensions;

-- 2. Private schema for the password hash. Not exposed to the API.
create schema if not exists tavern_private;
revoke all on schema tavern_private from public, anon, authenticated;

create table if not exists tavern_private.settings (
  id int primary key default 1 check (id = 1),
  password_hash text not null
);

-- 3. Public state table: one row per NPC per field. No row means "fresh".
create table if not exists public.tavern_state (
  npc        text        not null,
  field      text        not null,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (npc, field)
);

alter table public.tavern_state enable row level security;

drop policy if exists "Anyone can read tavern state" on public.tavern_state;
create policy "Anyone can read tavern state"
  on public.tavern_state for select
  to anon, authenticated
  using (true);

-- Reads only. Writes go through the functions below.
revoke all on public.tavern_state from anon, authenticated;
grant select on public.tavern_state to anon, authenticated;

-- 4. Realtime: push every change to open pages
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tavern_state'
  ) then
    alter publication supabase_realtime add table public.tavern_state;
  end if;
end $$;

-- 5. Private helpers
create or replace function tavern_private.check_password(p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select password_hash into v_hash from tavern_private.settings where id = 1;
  if v_hash is null then
    raise exception 'No table password has been set' using errcode = '28000';
  end if;
  if p_password is null or extensions.crypt(p_password, v_hash) <> v_hash then
    raise exception 'Wrong password' using errcode = '28P01';
  end if;
end;
$$;

-- Returns the kind of a field name, or null if the field isn't allowed.
create or replace function tavern_private.field_kind(p_field text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_field ~ '^(slot\.[1-9]|hd|use\.[a-z0-9_-]{1,30}|death\.[sf])$' then 'counter'
    when p_field ~ '^(damage|temp|pool\.[a-z0-9_-]{1,30})$'             then 'number'
    when p_field ~ '^(armour|cond\.[a-z_-]{1,20}|portent\.[0-9]\.used)$' then 'toggle'
    when p_field ~ '^(conc|portent\.[0-9]\.roll)$'                       then 'text'
    else null
  end;
$$;

-- Writes one value. Default values (0, false, empty text) delete the row.
create or replace function tavern_private.put(p_npc text, p_field text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_value is null
     or p_value = 'null'::jsonb
     or p_value = '0'::jsonb
     or p_value = 'false'::jsonb
     or p_value = '""'::jsonb then
    delete from public.tavern_state where npc = p_npc and field = p_field;
  else
    insert into public.tavern_state (npc, field, value, updated_at)
    values (p_npc, p_field, p_value, now())
    on conflict (npc, field) do update set value = excluded.value, updated_at = now();
  end if;
end;
$$;

create or replace function tavern_private.check_npc(p_npc text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_npc is null or p_npc !~ '^[a-z0-9_-]{1,40}$' then
    raise exception 'Unknown NPC id' using errcode = '22023';
  end if;
end;
$$;

-- 6. Public functions the page calls

-- Is this the right password? Used when a player unlocks the page.
create or replace function public.tavern_check(p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform tavern_private.check_password(p_password);
  return true;
exception when sqlstate '28P01' then
  return false;
end;
$$;

-- Set one field on one NPC.
create or replace function public.tavern_set(p_password text, p_npc text, p_field text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_num  numeric;
begin
  perform tavern_private.check_password(p_password);
  perform tavern_private.check_npc(p_npc);

  v_kind := tavern_private.field_kind(p_field);
  if v_kind is null then
    raise exception 'Field % is not an interactive field', p_field using errcode = '22023';
  end if;

  if p_value is not null and p_value <> 'null'::jsonb then
    if v_kind in ('counter', 'number') then
      if jsonb_typeof(p_value) <> 'number' then
        raise exception 'Field % needs a number', p_field using errcode = '22023';
      end if;
      v_num := (p_value #>> '{}')::numeric;
      if v_num <> trunc(v_num) or v_num < 0
         or (v_kind = 'counter' and v_num > 20)
         or (v_kind = 'number'  and v_num > 999) then
        raise exception 'Value out of range for %', p_field using errcode = '22023';
      end if;
    elsif v_kind = 'toggle' then
      if jsonb_typeof(p_value) <> 'boolean' then
        raise exception 'Field % needs true or false', p_field using errcode = '22023';
      end if;
    elsif v_kind = 'text' then
      if jsonb_typeof(p_value) <> 'string' or length(p_value #>> '{}') > 60 then
        raise exception 'Field % needs text of 60 characters or fewer', p_field using errcode = '22023';
      end if;
    end if;
  end if;

  perform tavern_private.put(p_npc, p_field, p_value);
end;
$$;

-- Damage (negative amount) or heal (positive amount) in one locked step,
-- so two people tapping at once both count.
-- Damage comes out of temp HP first. Healing from 0 HP clears death saves.
-- p_max is the NPC's hit point maximum, sent by the page from the YAML.
create or replace function public.tavern_hp(p_password text, p_npc text, p_amount int, p_max int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_damage   int;
  v_temp     int;
  v_absorbed int := 0;
  v_was_down boolean;
begin
  perform tavern_private.check_password(p_password);
  perform tavern_private.check_npc(p_npc);
  if p_amount is null or p_amount = 0 or abs(p_amount) > 999 or p_max is null or p_max < 1 or p_max > 999 then
    raise exception 'Amount out of range' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('tavern:' || p_npc));

  select coalesce((value #>> '{}')::int, 0) into v_damage from public.tavern_state where npc = p_npc and field = 'damage';
  select coalesce((value #>> '{}')::int, 0) into v_temp   from public.tavern_state where npc = p_npc and field = 'temp';
  v_damage := coalesce(v_damage, 0);
  v_temp   := coalesce(v_temp, 0);
  v_was_down := v_damage >= p_max;

  if p_amount < 0 then
    v_absorbed := least(v_temp, -p_amount);
    v_temp     := v_temp - v_absorbed;
    v_damage   := least(p_max, v_damage + (-p_amount - v_absorbed));
  else
    v_damage := greatest(0, least(v_damage, p_max) - p_amount);
    if v_was_down then
      delete from public.tavern_state where npc = p_npc and field in ('death.s', 'death.f');
    end if;
  end if;

  perform tavern_private.put(p_npc, 'damage', to_jsonb(v_damage));
  perform tavern_private.put(p_npc, 'temp',   to_jsonb(v_temp));
  return jsonb_build_object('damage', v_damage, 'temp', v_temp, 'absorbed', v_absorbed);
end;
$$;

-- Wipe one NPC back to fresh.
create or replace function public.tavern_reset(p_password text, p_npc text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform tavern_private.check_password(p_password);
  perform tavern_private.check_npc(p_npc);
  delete from public.tavern_state where npc = p_npc;
end;
$$;

-- 7. Who may call what
revoke all on function tavern_private.check_password(text)       from public, anon, authenticated;
revoke all on function tavern_private.field_kind(text)           from public, anon, authenticated;
revoke all on function tavern_private.put(text, text, jsonb)     from public, anon, authenticated;
revoke all on function tavern_private.check_npc(text)            from public, anon, authenticated;

revoke all on function public.tavern_check(text)                 from public;
revoke all on function public.tavern_set(text, text, text, jsonb) from public;
revoke all on function public.tavern_hp(text, text, int, int)    from public;
revoke all on function public.tavern_reset(text, text)           from public;
grant execute on function public.tavern_check(text)                 to anon, authenticated;
grant execute on function public.tavern_set(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.tavern_hp(text, text, int, int)    to anon, authenticated;
grant execute on function public.tavern_reset(text, text)           to anon, authenticated;

-- 8. Set or change the table password. Run this on its own, with your password in place of the placeholder.
--    Don't save the real password into this file.
--
-- insert into tavern_private.settings (id, password_hash)
-- values (1, extensions.crypt('your table password', extensions.gen_salt('bf')))
-- on conflict (id) do update set password_hash = excluded.password_hash;
