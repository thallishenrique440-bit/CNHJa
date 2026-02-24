-- 1. Create the APPOINTMENTS table
-- Updated to support 'blocked' slots (where student_id is null)
create table if not exists public.appointments (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  
  -- Relationships
  student_id uuid references public.profiles(id), -- Nullable for blocked slots
  instructor_id uuid not null references public.instructors(id),
  
  -- Lesson Details
  date date not null,
  start_time time not null,
  end_time time not null,
  category text check (category in ('A', 'B')), -- Nullable for blocked slots
  
  -- Financial Snapshot
  price integer not null default 0,
  
  -- Status Workflow
  -- Added 'blocked' to the allowed statuses
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'blocked', 'reserved')),

  -- Cancellation Audit (New Columns)
  cancelled_reason text,
  cancelled_by text check (cancelled_by in ('student', 'instructor'))
);

-- Enable RLS for appointments
alter table public.appointments enable row level security;

-- Policies for appointments

-- 1. View: Users can view their own appointments (Instrutor sees all theirs, Student sees all theirs)
create policy "Users can view their own appointments"
on public.appointments for select
using (auth.uid() = student_id OR auth.uid() = instructor_id);

-- 2. Insert (Student): Can book if they are the student_id
create policy "Students can book appointments"
on public.appointments for insert
with check (auth.uid() = student_id);

-- 3. Insert (Instructor): Can insert blocks (where they are instructor_id)
create policy "Instructors can block slots"
on public.appointments for insert
with check (auth.uid() = instructor_id);

-- 4. Update: Users can update their own appointments (e.g. status changes)
create policy "Users can update their own appointments"
on public.appointments for update
using (auth.uid() = student_id OR auth.uid() = instructor_id);

-- 5. Delete: Instructors can delete blocks (appointments with status 'blocked')
create policy "Instructors can delete blocks"
on public.appointments for delete
using (auth.uid() = instructor_id AND status = 'blocked');


-- 2. Create the REVIEWS table (Social Proof)
create table if not exists public.reviews (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  
  appointment_id uuid not null references public.appointments(id),
  student_id uuid not null references public.profiles(id),
  instructor_id uuid not null references public.instructors(id),
  
  rating integer not null check (rating >= 1 and rating <= 5),
  comment text,
  
  -- Constraints: One review per appointment
  unique(appointment_id)
);

-- Enable RLS for reviews
alter table public.reviews enable row level security;

-- Policies for reviews
create policy "Public can view reviews"
on public.reviews for select
using (true);

create policy "Students can create reviews for their own finished lessons"
on public.reviews for insert
with check (auth.uid() = student_id);


-- 3. Create the TRANSACTIONS table (Financial Ledger)
create table if not exists public.transactions (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  
  appointment_id uuid references public.appointments(id),
  student_id uuid not null references public.profiles(id),
  instructor_id uuid not null references public.instructors(id),
  
  type text not null check (type in ('lesson_payment', 'tip', 'refund', 'platform_fee')),
  amount integer not null, -- stored in cents
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed'))
);

-- Enable RLS for transactions
alter table public.transactions enable row level security;

-- Policies for transactions
create policy "Users see their own transactions"
on public.transactions for select
using (auth.uid() = student_id OR auth.uid() = instructor_id);

create policy "System/Students can create transactions"
on public.transactions for insert
with check (auth.uid() = student_id); -- In MVP, student triggers the payment creation upon completion

-- Grants
grant all on public.appointments to authenticated;
grant all on public.appointments to service_role;
grant all on public.reviews to authenticated;
grant all on public.reviews to service_role;
grant all on public.transactions to authenticated;
grant all on public.transactions to service_role;


-- ==============================================================================
-- MIGRATION: PREPARAÇÃO PARA RESERVAS, PAGAMENTOS E INTEGRIDADE
-- (Execute este bloco no SQL Editor para aplicar as mudanças)
-- ==============================================================================

-- 1. Atualizar Constraint de Status
DO $$
BEGIN
    ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_status_check
        CHECK (status IN ('pending', 'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'blocked', 'reserved', 'failed'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 2. Adicionar Colunas Necessárias (Safe Add)
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS purchase_id uuid;
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS payment_id text;

-- 3. Índices de Performance
-- Nota: idx_unique_active_slot já previne double booking.

-- Acelera o Garbage Collector (cleanup-scheduler)
CREATE INDEX IF NOT EXISTS idx_appointments_expires_at_reserved
    ON public.appointments (expires_at)
    WHERE status = 'reserved';

-- Acelera a busca de aulas agrupadas por compra
CREATE INDEX IF NOT EXISTS idx_appointments_purchase_id
    ON public.appointments (purchase_id);

-- Acelera o Webhook do Mercado Pago
CREATE INDEX IF NOT EXISTS idx_appointments_payment_id
    ON public.appointments (payment_id);

-- 4. Garantir permissões para a Service Role
GRANT ALL ON public.appointments TO service_role;

-- ==============================================================================
-- MIGRATION: STRIPE CONNECT EXPRESS (MARKETPLACE)
-- ==============================================================================

-- 1. Atualizar tabela INSTRUCTORS para vincular conta Stripe
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS stripe_account_id text, -- ID da conta Express (acct_...)
ADD COLUMN IF NOT EXISTS stripe_onboarding_completed boolean DEFAULT false, -- Se completou o fluxo
ADD COLUMN IF NOT EXISTS payouts_enabled boolean DEFAULT false; -- Se a Stripe liberou recebimentos

-- 2. Atualizar tabela APPOINTMENTS para Destination Charges
ALTER TABLE public.appointments
ADD COLUMN IF NOT EXISTS payment_intent_id text, -- ID da transação na Stripe (pi_...)
ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'pending';

-- Adicionar Constraint de status de pagamento
DO $$
BEGIN
    ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_payment_status_check;
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_payment_status_check
        CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 3. Limpeza de colunas antigas/não utilizadas (se existirem de tentativas anteriores)
ALTER TABLE public.appointments 
DROP COLUMN IF EXISTS transfer_group,
DROP COLUMN IF EXISTS transfer_id,
DROP COLUMN IF EXISTS payout_status;

-- ==============================================================================
-- MIGRATION FINAL: CORREÇÃO DE ÍNDICE DE UNICIDADE (Fix Error 23505)
-- ==============================================================================

-- 1. Remover índices antigos que causam conflito ou são redundantes
DROP INDEX IF EXISTS public.uniq_instructor_timeslot;
DROP INDEX IF EXISTS public.idx_unique_active_slot;

-- 2. Criar o índice parcial definitivo
-- Regra: Garante unicidade apenas para agendamentos "ativos".
-- Exceção: Permite reutilização se o status for 'cancelled' ou 'failed'.
-- Status considerados ativos (Bloqueiam inserção): pending, reserved, scheduled, confirmed, in_progress, completed, blocked.

CREATE UNIQUE INDEX idx_unique_active_slot
ON public.appointments (instructor_id, date, start_time)
WHERE status NOT IN ('cancelled', 'failed');

-- ==============================================================================
-- MIGRATION: PRICING BY CATEGORY (PHASE 1)
-- ==============================================================================

create table if not exists public.instructor_categories (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  category text not null check (category in ('A', 'B')),
  
  price_day integer not null default 0, -- in cents
  price_night integer not null default 0, -- in cents
  
  -- Constraint: One entry per category per instructor
  unique(instructor_id, category)
);

-- Enable RLS
alter table public.instructor_categories enable row level security;

-- Policies
create policy "Public can view instructor categories"
on public.instructor_categories for select
using (true);

create policy "Instructors can manage their own categories"
on public.instructor_categories for all
using (auth.uid() = instructor_id)
with check (auth.uid() = instructor_id);

-- Grant permissions
grant all on public.instructor_categories to authenticated;
grant all on public.instructor_categories to service_role;