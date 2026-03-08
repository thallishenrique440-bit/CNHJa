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

-- 1. View: Authenticated users can view all appointments (to check availability)
create policy "Authenticated users can view all appointments"
on public.appointments for select
to authenticated
using (true);

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
-- MIGRATION: MARKETPLACE EVOLUTION (PHASE 2) - MANUAL APPROVAL & FINANCE
-- ==============================================================================

-- 1. Atualizar Status de Agendamento (Adicionar pending_approval, expired, rejected)
DO $$
BEGIN
    ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_status_check
        CHECK (status IN ('pending', 'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'blocked', 'reserved', 'failed', 'pending_approval', 'expired', 'rejected'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 2. Atualizar Status de Pagamento (Adicionar authorized, released)
DO $$
BEGIN
    ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_payment_status_check;
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_payment_status_check
        CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded', 'authorized', 'released'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 3. Melhorar Tabela de Transações (Financeiro Robusto)
-- Adicionar colunas para rastreabilidade total com Stripe
ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
ADD COLUMN IF NOT EXISTS stripe_transfer_id text,
ADD COLUMN IF NOT EXISTS stripe_payout_id text,
ADD COLUMN IF NOT EXISTS description text,
ADD COLUMN IF NOT EXISTS metadata jsonb;

-- Atualizar constraint de tipos de transação para incluir repasses e ajustes
DO $$
BEGIN
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
        CHECK (type IN ('lesson_payment', 'tip', 'refund', 'platform_fee', 'transfer_in', 'payout', 'adjustment'));
EXCEPTION
    WHEN others THEN NULL;
END $$;

-- 4. Criar Tabela de Notificações
create table if not exists public.notifications (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  
  user_id uuid not null references public.profiles(id),
  title text not null,
  message text not null,
  type text not null check (type in ('booking_request', 'booking_accepted', 'booking_rejected', 'booking_cancelled', 'booking_expired', 'payment_released', 'reminder', 'system')),
  read boolean not null default false,
  metadata jsonb -- Para linkar com appointment_id, etc.
);

-- RLS para Notificações
alter table public.notifications enable row level security;

create policy "Users can view their own notifications"
on public.notifications for select
using (auth.uid() = user_id);

create policy "System can insert notifications"
on public.notifications for insert
with check (true); -- Service Role bypasses, but needed for edge functions if using anon key (usually service role is used)

create policy "Users can update their own notifications (mark as read)"
on public.notifications for update
using (auth.uid() = user_id);

-- Grants
grant all on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- 5. Atualizar Índice de Unicidade (Garantir que pending_approval bloqueie horário)
-- O índice anterior "WHERE status NOT IN ('cancelled', 'failed')" JÁ COBRE os novos status.
-- pending_approval, confirmed, reserved -> Todos bloqueiam.
-- expired, rejected -> Devem liberar.

DROP INDEX IF EXISTS idx_unique_active_slot;

CREATE UNIQUE INDEX idx_unique_active_slot
ON public.appointments (instructor_id, date, start_time)
WHERE status NOT IN ('cancelled', 'failed', 'rejected', 'expired'); 
-- Adicionamos rejected e expired na lista de EXCLUSÃO, pois esses status liberam a agenda.

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

-- ==============================================================================
-- MIGRATION: INSTRUCTOR DISCOUNTS (PROGRESSIVE PRICING)
-- ==============================================================================

create table if not exists public.instructor_discounts (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),

  instructor_id uuid not null references public.instructors(id) on delete cascade,
  min_lessons integer not null check (min_lessons > 0),
  discount_percentage integer not null check (discount_percentage > 0 and discount_percentage <= 100),

  -- Constraint: Prevent duplicate rules for same instructor and lesson count
  unique(instructor_id, min_lessons)
);

-- Enable RLS
alter table public.instructor_discounts enable row level security;

-- Policies
create policy "Public can view instructor discounts"
on public.instructor_discounts for select
using (true);

create policy "Instructors can manage their own discounts"
on public.instructor_discounts for all
using (auth.uid() = instructor_id)
with check (auth.uid() = instructor_id);

-- Index for fast lookup
create index if not exists idx_instructor_discounts_instructor_id
on public.instructor_discounts(instructor_id);

-- Grant permissions
grant all on public.instructor_discounts to authenticated;
-- ==============================================================================
-- MIGRATION: INSTRUCTOR AGENDA CONFIGURATION
-- ==============================================================================

ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS work_saturday_afternoon boolean DEFAULT false;
