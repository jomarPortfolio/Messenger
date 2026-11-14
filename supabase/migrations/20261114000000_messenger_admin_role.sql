-- Messenger-only admin role for admin2@gmail.com.
-- This uses Supabase Auth app_metadata as the trusted authorization source.
-- It does not change the user's password or public.profiles.role.

alter table public.messenger_profiles
  add column if not exists role text not null default 'user'
  check (role in ('user', 'admin'));

insert into public.messenger_profiles (id, username, display_name, role)
values (
  'b81b8644-fe2d-4baf-9883-58981d81cac0',
  'admin2',
  'Messenger Admin',
  'admin'
)
on conflict (id) do update
set username = excluded.username,
    display_name = excluded.display_name,
    role = 'admin',
    updated_at = now();

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('messenger_role', 'admin')
where id = 'b81b8644-fe2d-4baf-9883-58981d81cac0'
  and lower(email) = 'admin2@gmail.com';

-- Prevent a normal signed-in user from promoting their own Messenger profile.
create or replace function public.prevent_messenger_role_self_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Messenger role can only be changed by a trusted administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists messenger_profiles_protect_role
  on public.messenger_profiles;

create trigger messenger_profiles_protect_role
before update on public.messenger_profiles
for each row
execute function public.prevent_messenger_role_self_change();
