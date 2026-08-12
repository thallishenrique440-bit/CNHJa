/**
 * Global Type Definitions for CNHJÁ Payment Provider Abstraction
 * Configured exclusively for Asaas payment gateway.
 */

export type PaymentProvider = 'asaas';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'authorized' | 'released' | 'refund_requested';

export type AppointmentStatus =
  | 'pending'
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked'
  | 'reserved'
  | 'failed'
  | 'pending_approval'
  | 'expired'
  | 'rejected'
  | 'no_show'
  | 'awaiting_payment'
  | 'cancelling';

export type TransactionType =
  | 'lesson_payment'
  | 'tip'
  | 'refund'
  | 'platform_fee'
  | 'transfer_in'
  | 'payout'
  | 'adjustment';

export interface Profile {
  id: string;
  created_at: string;
  email?: string;
  full_name: string;
  phone?: string;
  role: 'student' | 'instructor';
  
  // Generic Payment Provider abstraction fields
  provider_name?: PaymentProvider;
  provider_customer_id?: string | null;
}

export interface Instructor {
  id: string;
  created_at: string;
  bio?: string;
  address?: string;
  is_verified: boolean;
  payouts_enabled: boolean;
  work_saturday_afternoon: boolean;
  
  // Generic Payment Provider abstraction fields
  provider_name?: PaymentProvider;
  provider_account_id?: string | null;
  provider_wallet_id?: string | null;
  provider_onboarding_completed?: boolean;
  provider_status?: 'pending' | 'approved' | 'rejected' | string;
}

export interface Appointment {
  id: string;
  created_at: string;
  student_id: string | null;
  instructor_id: string;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:MM:SS
  end_time: string; // HH:MM:SS
  category: 'A' | 'B' | null;
  price: number; // in cents
  status: AppointmentStatus;
  
  expires_at?: string | null;
  purchase_id?: string | null;
  payment_id?: string | null;
  payment_status?: PaymentStatus;
  payment_intent_id?: string | null;
  
  // Generic Payment Provider abstraction fields
  provider_name?: PaymentProvider;
  provider_payment_id?: string | null;
}

export interface FinancialTransaction {
  id: string;
  created_at: string;
  appointment_id?: string | null;
  student_id: string;
  instructor_id: string;
  type: TransactionType;
  amount: number; // stored in cents (legacy/display)
  gross_amount: number;
  platform_fee: number;
  net_amount: number;
  status: 'pending' | 'completed' | 'failed';
  event_date: string;
  description?: string | null;
  metadata?: Record<string, any> | null;
  
  // Generic Payment Provider abstraction fields
  provider_name?: PaymentProvider;
  provider_payment_id?: string | null;
  provider_transfer_id?: string | null;
  provider_payout_id?: string | null;
}
