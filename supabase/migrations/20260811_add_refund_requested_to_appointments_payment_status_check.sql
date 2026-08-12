-- Migration: Add 'refund_requested' status to appointments_payment_status_check constraint

ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_payment_status_check;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_payment_status_check
    CHECK (
        payment_status IN (
            'pending',
            'paid',
            'failed',
            'refunded',
            'authorized',
            'released',
            'refund_requested'
        )
    );

