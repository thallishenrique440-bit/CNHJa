-- Migration: Add 'cancelling' transient lock status to appointments_status_check constraint
-- Resolves ERROR 23514 when BookingCancellationCore sets status to 'cancelling' during auto-expiration or cancellation locking.

DO $$
BEGIN
    ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
    ALTER TABLE public.appointments ADD CONSTRAINT appointments_status_check
        CHECK (status IN (
            'pending',
            'pending_approval',
            'confirmed',
            'scheduled',
            'completed',
            'cancelled',
            'expired',
            'no_show',
            'reserved',
            'awaiting_payment',
            'blocked',
            'cancelling'
        ));
END $$;

