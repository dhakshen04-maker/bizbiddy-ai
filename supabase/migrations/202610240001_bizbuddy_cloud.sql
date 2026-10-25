-- BizBuddy account-owned data. The browser uses only the project's anon/publishable key.
create table if not exists public.business_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.products (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.business_profiles enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.app_settings enable row level security;
revoke all on public.business_profiles, public.customers, public.products, public.app_settings from anon, public;
grant select, insert, update, delete on public.business_profiles, public.customers, public.products, public.app_settings to authenticated;

drop policy if exists "Users manage their business profile" on public.business_profiles;
create policy "Users manage their business profile" on public.business_profiles
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users manage their customers" on public.customers;
create policy "Users manage their customers" on public.customers
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users manage their products" on public.products;
create policy "Users manage their products" on public.products
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users manage their app settings" on public.app_settings;
create policy "Users manage their app settings" on public.app_settings
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Save is an atomic snapshot update scoped to auth.uid().
create or replace function public.save_bizbuddy_data(p_payload jsonb)
returns void language plpgsql security invoker set search_path = public
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(p_payload->'business') <> 'object'
    or jsonb_typeof(p_payload->'customers') <> 'array'
    or jsonb_typeof(p_payload->'products') <> 'array'
    or jsonb_typeof(p_payload->'settings') <> 'object' then
    raise exception 'Invalid BizBuddy data';
  end if;

  insert into business_profiles(user_id, profile, updated_at)
  values (owner_id, p_payload->'business', now())
  on conflict (user_id) do update set profile = excluded.profile, updated_at = now();

  insert into customers(user_id, id, data)
  select owner_id, item->>'id', item
  from jsonb_array_elements(p_payload->'customers') item
  where coalesce(item->>'id', '') <> ''
  on conflict (user_id, id) do update set data = excluded.data;
  delete from customers c where c.user_id = owner_id and not exists (
    select 1 from jsonb_array_elements(p_payload->'customers') item where item->>'id' = c.id
  );

  insert into products(user_id, id, data)
  select owner_id, item->>'id', item
  from jsonb_array_elements(p_payload->'products') item
  where coalesce(item->>'id', '') <> ''
  on conflict (user_id, id) do update set data = excluded.data;
  delete from products p where p.user_id = owner_id and not exists (
    select 1 from jsonb_array_elements(p_payload->'products') item where item->>'id' = p.id
  );

  insert into app_settings(user_id, settings, updated_at)
  values (owner_id, p_payload->'settings', now())
  on conflict (user_id) do update set settings = excluded.settings, updated_at = now();
end;
$$;

-- Migration is insert-only and all-or-nothing. Existing account data always stops it.
create or replace function public.migrate_bizbuddy_data(p_payload jsonb)
returns void language plpgsql security invoker set search_path = public
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_payload) <> 'object'
    or jsonb_typeof(p_payload->'business') <> 'object'
    or jsonb_typeof(p_payload->'customers') <> 'array'
    or jsonb_typeof(p_payload->'products') <> 'array'
    or jsonb_typeof(p_payload->'settings') <> 'object' then
    raise exception 'Invalid BizBuddy data';
  end if;
  if exists (select 1 from business_profiles where user_id = owner_id)
    or exists (select 1 from customers where user_id = owner_id)
    or exists (select 1 from products where user_id = owner_id)
    or exists (select 1 from app_settings where user_id = owner_id) then
    raise exception 'Cloud data already exists. Migration was stopped to prevent overwriting it.';
  end if;

  insert into business_profiles(user_id, profile) values (owner_id, p_payload->'business');
  insert into customers(user_id, id, data)
  select owner_id, item->>'id', item from jsonb_array_elements(p_payload->'customers') item
  where coalesce(item->>'id', '') <> '';
  insert into products(user_id, id, data)
  select owner_id, item->>'id', item from jsonb_array_elements(p_payload->'products') item
  where coalesce(item->>'id', '') <> '';
  insert into app_settings(user_id, settings) values (owner_id, p_payload->'settings');
end;
$$;

revoke all on function public.save_bizbuddy_data(jsonb) from public, anon;
revoke all on function public.migrate_bizbuddy_data(jsonb) from public, anon;
grant execute on function public.save_bizbuddy_data(jsonb) to authenticated;
grant execute on function public.migrate_bizbuddy_data(jsonb) to authenticated;
