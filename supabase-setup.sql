-- ============================================================
-- MAISON VIE — RESERVATION SYSTEM · SUPABASE SETUP
-- ============================================================
-- Run this in Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- 1) Create the reservations table
create table if not exists public.reservations (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  name                text not null,
  email               text not null,
  phone               text not null,
  guests              int  not null,
  res_date            date not null,
  res_time            text not null,
  dietary             text[],            -- array: vegetarian, vegan, gluten_free, seafood_allergy, nut_allergy, halal
  notes               text,
  language            text default 'en', -- which language the guest used (en/fr/vi/ja)
  status              text default 'pending',  -- pending / confirmed / declined / rescheduled
  seating_preference  text default 'standard', -- standard / private / window
  purpose             text default 'fine_dining', -- fine_dining / business / anniversary / proposal
  reschedule_notes    text,              -- notes in case of rescheduling
  reminder_sent       boolean not null default false, -- for cron reminder tracking
  customer_segment    text not null default 'Standard' -- Standard / Premium / VIP
);

-- 2) Enable Row Level Security
alter table public.reservations enable row level security;

-- 3) PUBLIC (website) — may INSERT new reservations only.
create policy "Public can create reservations"
  on public.reservations
  for insert
  to anon
  with check (true);

-- ============================================================
-- 4) STAFF DASHBOARD policies (SECURED WITH SUPABASE AUTH)
-- ============================================================
-- The dashboard now requires official Supabase GoTrue Auth.
-- Only logged-in staff (authenticated role) can read/write data.
-- ------------------------------------------------------------

-- 4a) Allow reading reservations (for the authenticated dashboard list)
create policy "Dashboard can read reservations"
  on public.reservations
  for select
  to authenticated
  using (true);

-- 4b) Allow updating the status (confirm / cancel / edit)
create policy "Dashboard can update reservations"
  on public.reservations
  for update
  to authenticated
  using (true)
  with check (true);

-- 5) Helpful index (by date / time)
create index if not exists reservations_date_idx
  on public.reservations (res_date, res_time);

-- ============================================================
-- 5) DYNAMIC CAPACITY CHECK FUNCTION
-- ============================================================
-- Used by the website frontend to check booked slots for a given date
create or replace function public.check_slot_capacity(target_date date)
returns table (res_time text, total_guests bigint) as $$
begin
  return query
  select r.res_time, sum(r.guests) as total_guests
  from public.reservations r
  where r.res_date = target_date and r.status in ('pending', 'confirmed')
  group by r.res_time;
end;
$$ language plpgsql security definer;

-- ============================================================
-- 6) AUTOMATED VIP SEGMENTATION TRIGGER
-- ============================================================
-- Rule-based segmentation based on guest history and purpose
create or replace function public.auto_segment_customer()
returns trigger as $$
declare
  booking_count int;
begin
  -- Count historical confirmed/pending bookings with same email or phone
  select count(*) into booking_count
  from public.reservations
  where (email = new.email or phone = new.phone)
    and status in ('pending', 'confirmed');
    
  -- If total bookings >= 3, automatically segment as VIP
  if booking_count >= 3 then
    new.customer_segment := 'VIP';
  -- If the occasion is Business or Proposal, automatically segment as Premium
  elsif new.purpose in ('business', 'proposal') then
    new.customer_segment := 'Premium';
  else
    new.customer_segment := 'Standard';
  end if;
  
  return new;
end;
$$ language plpgsql security definer;

-- Create/Replace Trigger
create or replace trigger reservations_auto_segment
  before insert or update of status, purpose, email, phone
  on public.reservations
  for each row
  execute function public.auto_segment_customer();
