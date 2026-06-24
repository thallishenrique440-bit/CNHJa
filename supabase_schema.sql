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
  amount integer not null, -- stored in cents (legacy/display)
  gross_amount integer,    -- total paid by student
  platform_fee integer,    -- amount kept by platform
  net_amount integer,      -- amount to be paid to instructor
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  event_date timestamptz   -- logical date of the event for sorting
);

-- Documentation: Financial Ledger Standards
-- 1. All amounts are stored in CENTS (integer).
-- 2. 'lesson_payment' and 'tip' types are POSITIVE (inflow).
-- 3. 'refund' type MUST be NEGATIVE (outflow) for gross_amount, platform_fee, and net_amount.
-- 4. 'platform_fee' is the amount kept by the platform (usually 10% of gross).
-- 5. 'net_amount' is the amount destined for the instructor (gross - fee).

-- Migration for existing transactions (ensure refunds are negative)
update public.transactions
set 
  amount = -abs(amount),
  gross_amount = -abs(gross_amount),
  platform_fee = -abs(platform_fee),
  net_amount = -abs(net_amount)
where type = 'refund';

-- Migration for existing transactions (ensure non-refunds are positive)
update public.transactions
set 
  amount = abs(amount),
  gross_amount = abs(gross_amount),
  platform_fee = abs(platform_fee),
  net_amount = abs(net_amount)
where type != 'refund';

-- Migration for existing transactions (populate new fields if null)
update public.transactions
set 
  gross_amount = amount,
  platform_fee = case when type = 'lesson_payment' then floor(amount * 0.1) else 0 end,
  net_amount = case when type = 'lesson_payment' then amount - floor(amount * 0.1) else amount end,
  event_date = created_at
where gross_amount is null;

-- Make columns required after migration (except maybe for very old data if we want to be safe, but here we can)
alter table public.transactions 
  alter column gross_amount set not null,
  alter column platform_fee set not null,
  alter column net_amount set not null,
  alter column event_date set not null;

-- Enable RLS for transactions
alter table public.transactions enable row level security;

-- Policies for transactions
create policy "Users see their own transactions"
on public.transactions for select
using (auth.uid() = student_id OR auth.uid() = instructor_id);

-- Only service_role and backend processes can create transactions. No INSERT policy for 'authenticated' exists.

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
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS reschedule_requested_at timestamptz;
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS rescheduled_at timestamptz;

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

-- 1. Atualizar tabela PROFILES para vincular cliente Stripe
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- 2. Atualizar tabela INSTRUCTORS para vincular conta Stripe
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS stripe_account_id text, -- ID da conta Express (acct_...)
ADD COLUMN IF NOT EXISTS stripe_onboarding_completed boolean DEFAULT false, -- Se completou o fluxo
ADD COLUMN IF NOT EXISTS payouts_enabled boolean DEFAULT false, -- Se a Stripe liberou recebimentos
ADD COLUMN IF NOT EXISTS meeting_point_lat float8,
ADD COLUMN IF NOT EXISTS meeting_point_lng float8,
ADD COLUMN IF NOT EXISTS meeting_point_place_id text;

-- 2. Atualizar tabela APPOINTMENTS para Destination Charges
ALTER TABLE public.appointments
ADD COLUMN IF NOT EXISTS payment_intent_id text, -- ID da transação na Stripe (pi_...)
ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS is_last_minute boolean DEFAULT false;

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
        CHECK (status IN ('pending', 'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'blocked', 'reserved', 'failed', 'pending_approval', 'expired', 'rejected', 'no_show', 'awaiting_payment'));
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
  metadata jsonb, -- Para linkar com appointment_id, etc.
  idempotency_key text unique -- Chave única para evitar duplicidade (ex: type:group_id)
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

DROP INDEX IF EXISTS idx_unique_student_active_slot;

CREATE UNIQUE INDEX idx_unique_student_active_slot
ON public.appointments (student_id, date, start_time)
WHERE status NOT IN ('cancelled', 'failed', 'rejected', 'expired') 
AND student_id IS NOT NULL;

create table if not exists public.instructor_categories (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  category text not null check (category in ('A', 'B')),
  
  day_price integer not null default 0, -- in cents
  night_price integer not null default 0, -- in cents
  
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

-- ==============================================================================
-- MIGRATION: TIP SYSTEM (CAIXINHA) INTEGRITY
-- ==============================================================================

-- 1. Índice Único para Caixinhas (Garantir 1 por aula)
-- Impede que chamadas simultâneas ou erros de UI gerem cobranças duplicadas para a mesma aula.
CREATE UNIQUE INDEX IF NOT EXISTS unique_tip_per_appointment 
ON public.transactions (appointment_id) 
WHERE type = 'tip' AND status = 'completed';

-- 2. Índice Único para Pagamentos de Aula (Garantir 1 por aula)
-- Impede que o processo de conclusão de aulas ou erros de UI gerem pagamentos duplicados.
CREATE UNIQUE INDEX IF NOT EXISTS unique_lesson_payment_per_appointment 
ON public.transactions (appointment_id) 
WHERE type = 'lesson_payment' AND status = 'completed';

-- 3. Create RPC to check for pending reviews
-- Returns the first completed or past due appointment for an instructor that hasn't been reviewed yet
-- UX Rule: If another appointment from the same purchase group was reviewed, don't prompt automatically
CREATE OR REPLACE FUNCTION public.get_pending_review(p_student_id UUID)
RETURNS TABLE (
  appointment_id UUID,
  instructor_id UUID,
  instructor_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id as appointment_id,
    a.instructor_id,
    p.full_name as instructor_name
  FROM public.appointments a
  JOIN public.profiles p ON a.instructor_id = p.id
  WHERE a.student_id = p_student_id
    -- Status: Completed or past due (50 min margin)
    AND (
      a.status = 'completed' 
      OR (
        a.status IN ('confirmed', 'scheduled') 
        AND (a.date + a.start_time) < (now() - interval '50 minutes')
      )
    )
    -- This specific appointment hasn't been reviewed
    AND NOT EXISTS (
      SELECT 1 FROM public.reviews r 
      WHERE r.appointment_id = a.id
    )
    -- UX Rule: If purchase_id is set, check if ANY appointment in that group was reviewed
    AND CASE 
      WHEN a.purchase_id IS NULL THEN TRUE
      ELSE NOT EXISTS (
        SELECT 1 FROM public.reviews r2
        JOIN public.appointments a2 ON r2.appointment_id = a2.id
        WHERE a2.purchase_id = a.purchase_id
          AND a2.student_id = p_student_id
      )
    END
  ORDER BY a.date DESC, a.start_time DESC
  LIMIT 1;
END;
$$;

-- 5. RPC to auto-complete lessons that have passed
-- Threshold: end_time + 3 hours < now
-- Since we don't have end_time, we use (date + start_time) + 50 mins + 3 hours = 230 minutes
CREATE OR REPLACE FUNCTION public.auto_complete_lessons()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  -- 1. Update Appointments
  UPDATE public.appointments
  SET 
    status = 'completed',
    updated_at = now()
  WHERE 
    status = 'confirmed' 
    AND (date + start_time) < (now() - interval '230 minutes');
    
  GET DIAGNOSTICS updated_count = ROW_COUNT;

  -- 2. Update Transactions (captured -> completed)
  -- Only for transactions linked to appointments that are now completed
  UPDATE public.transactions t
  SET 
    status = 'completed',
    description = 'Aula Concluída'
  FROM public.appointments a
  WHERE t.appointment_id = a.id
    AND a.status = 'completed'
    AND t.status = 'pending';

  RETURN updated_count;
END;
$$;

-- 6. Composite Index for performance
CREATE INDEX IF NOT EXISTS idx_appointments_student_instructor_status_date 
ON public.appointments (student_id, instructor_id, status, date DESC);

-- ==============================================================================
-- MIGRATION: FINANCE REAL-TIME MIRROR (PHASE 3)
-- ==============================================================================

-- 1. Backfill stripe_payment_intent_id from appointments
-- This links existing transactions to their Stripe PaymentIntents for idempotency.
UPDATE public.transactions t
SET stripe_payment_intent_id = a.payment_intent_id
FROM public.appointments a
WHERE t.appointment_id = a.id 
AND t.stripe_payment_intent_id IS NULL 
AND a.payment_intent_id IS NOT NULL;

-- 2. Create Unique Index for Idempotency (PI + Type + Appointment)
-- This ensures that for a given Stripe PaymentIntent, each transaction type (lesson_payment, tip, etc.) is recorded once per appointment.
-- This supports combos (multiple appointments per PaymentIntent) while maintaining idempotency.
-- The WHERE clause ensures we don't conflict with legacy data that lacks a PI ID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_pi_type_appointment 
ON public.transactions (stripe_payment_intent_id, type, appointment_id) 
WHERE stripe_payment_intent_id IS NOT NULL;

-- Remove the old index that was too restrictive for combos
DROP INDEX IF EXISTS idx_transactions_stripe_pi_type;

-- 3. Performance Indexes for Financial Dashboard
-- Speeds up queries for "A Receber", "Em Processamento" and "Transferido"
CREATE INDEX IF NOT EXISTS idx_transactions_instructor_status 
ON public.transactions (instructor_id, status);

CREATE INDEX IF NOT EXISTS idx_transactions_stripe_payout_id 
ON public.transactions (stripe_payout_id);


-- ==============================================================================
-- MIGRATION: PAYMENT PROVIDER ABSTRACTION (FASE D.1)
-- ==============================================================================

-- 1. Profiles: Genéricamente associado a um cliente de provedor de pagamentos
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_customer_id text;

-- 2. Instructors: Vinculação de subconta/carteira de provedor genérico
ALTER TABLE public.instructors
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_account_id text, -- ID da conta/subconta genérica
ADD COLUMN IF NOT EXISTS provider_wallet_id text,  -- ID adicional para carteiras (ex: Asaas Wallet ID)
ADD COLUMN IF NOT EXISTS provider_onboarding_completed boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS provider_status text DEFAULT 'pending'; -- Status cadastral/onboarding

-- 3. Appointments: Vinculação de transação com provedor genérico
ALTER TABLE public.appointments
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_payment_id text; -- ID do pagamento/cobrança no provedor

-- 4. Transactions: Rastreabilidade financeira multiprovedor
ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS provider_name text DEFAULT 'stripe',
ADD COLUMN IF NOT EXISTS provider_payment_id text,
ADD COLUMN IF NOT EXISTS provider_transfer_id text,
ADD COLUMN IF NOT EXISTS provider_payout_id text;

-- 5. Índices de Idempotência e Performance para a camada de abstração genérica
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_provider_type_appointment 
ON public.transactions (provider_payment_id, type, appointment_id) 
WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_provider_payout_id 
ON public.transactions (provider_payout_id);


-- ==============================================================================
-- SECURITY HARDENING (D.7.3)
-- ==============================================================================

-- 1. Create security check function for appointments updates
CREATE OR REPLACE FUNCTION public.check_appointments_update_security()
RETURNS TRIGGER AS $$
BEGIN
  -- We ONLY enforce this check for non-service_role requests (authenticated/anon users via Client SDK)
  -- service_role automatically bypasses this if we check auth.role() = 'authenticated'
  IF auth.role() = 'authenticated' THEN
    
    -- Prevent alteration of sensitive financial and provider columns
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
      RAISE EXCEPTION 'Alteracao de payment_status nao permitida via client.';
    END IF;

    IF NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id THEN
      RAISE EXCEPTION 'Alteracao de payment_intent_id nao permitida via client.';
    END IF;

    IF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
      RAISE EXCEPTION 'Alteracao de provider_payment_id nao permitida via client.';
    END IF;

    IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id THEN
      RAISE EXCEPTION 'Alteracao de purchase_id nao permitida via client.';
    END IF;

    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id THEN
      RAISE EXCEPTION 'Alteracao de payment_id nao permitida via client.';
    END IF;

    IF NEW.price IS DISTINCT FROM OLD.price THEN
      RAISE EXCEPTION 'Alteracao de price nao permitida via client.';
    END IF;

    IF NEW.provider_name IS DISTINCT FROM OLD.provider_name THEN
      RAISE EXCEPTION 'Alteracao de provider_name nao permitida via client.';
    END IF;

    -- If status is changed, restrict to allowed client transitions (completed, cancelled, no_show, pending_approval)
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status NOT IN ('cancelled', 'completed', 'no_show', 'pending_approval') THEN
        RAISE EXCEPTION 'Alteracao de status nao autorizada ou invalida via client: %', NEW.status;
      END IF;
    END IF;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Bind the security check trigger to public.appointments
DROP TRIGGER IF EXISTS appointments_security_check_trigger ON public.appointments;

CREATE TRIGGER appointments_security_check_trigger
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_appointments_update_security();


-- ===============================================================
-- Configurações Financeiras da Plataforma (Repasse de Taxas)
-- ===============================================================

CREATE TABLE IF NOT EXISTS public.platform_financial_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  pix_flat_fee integer NOT NULL DEFAULT 149, -- em centavos (ex: R$1,49)
  credit_1x_fee numeric(5,2) NOT NULL DEFAULT 3.99, -- em percentual (ex: 3.99%)
  credit_2x_fee numeric(5,2) NOT NULL DEFAULT 5.49,
  credit_3x_fee numeric(5,2) NOT NULL DEFAULT 6.49,
  credit_4x_fee numeric(5,2) NOT NULL DEFAULT 7.49,
  credit_5x_fee numeric(5,2) NOT NULL DEFAULT 8.49,
  credit_6x_fee numeric(5,2) NOT NULL DEFAULT 9.49,
  credit_7x_fee numeric(5,2) NOT NULL DEFAULT 10.49,
  credit_8x_fee numeric(5,2) NOT NULL DEFAULT 11.49,
  credit_9x_fee numeric(5,2) NOT NULL DEFAULT 12.49,
  credit_10x_fee numeric(5,2) NOT NULL DEFAULT 13.49,
  credit_11x_fee numeric(5,2) NOT NULL DEFAULT 14.49,
  credit_12x_fee numeric(5,2) NOT NULL DEFAULT 15.49
);

-- Habilitar RLS
ALTER TABLE public.platform_financial_settings ENABLE ROW LEVEL SECURITY;

-- Permitir leitura pública para alunos/professores/anon
CREATE POLICY "Allow read access to anyone"
  ON public.platform_financial_settings FOR SELECT
  USING (true);

-- Inserir registro inicial padrão se não houver nenhum
INSERT INTO public.platform_financial_settings (
  id,
  pix_flat_fee,
  credit_1x_fee, credit_2x_fee, credit_3x_fee, credit_4x_fee, credit_5x_fee, credit_6x_fee,
  credit_7x_fee, credit_8x_fee, credit_9x_fee, credit_10x_fee, credit_11x_fee, credit_12x_fee
)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  149,
  3.99, 5.49, 6.49, 7.49, 8.49, 9.49,
  10.49, 11.49, 12.49, 13.49, 14.49, 15.49
)
ON CONFLICT (id) DO NOTHING;



