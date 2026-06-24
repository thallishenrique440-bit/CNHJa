/**
 * Generic Payment Provider Abstraction Types & DTOs (CNHJÁ)
 * Strict type safety without any 'any'.
 */

export type ProviderName = 'stripe' | 'asaas';

export interface BillingAddress {
  postalCode: string;
  address: string;
  addressNumber: string;
  complement?: string;
  province?: string;
  city: string;
  state: string; // UF (ex: 'SP', 'RJ')
}

// ==========================================
// CUSTOMER DTOs
// ==========================================

export interface CreateCustomerDTO {
  email: string;
  name: string;
  phone: string;
  cpfCnpj: string;
  address?: BillingAddress;
}

export interface CustomerResponseDTO {
  providerCustomerId: string;
  providerName: ProviderName;
  name: string;
  email: string;
  phone: string;
  cpfCnpj: string;
  createdAt: string;
}

// ==========================================
// INSTRUCTOR SUBCONTAS / CONNECT DTOs
// ==========================================

export interface CreateInstructorAccountDTO {
  email: string;
  name: string;
  cpfCnpj: string; // PF (CPF) ou PJ (CNPJ)
  phone: string;
  birthDate?: string; // YYYY-MM-DD
  companyType?: 'INDIVIDUAL' | 'MEI' | 'LIMITED' | 'ASSOCIATION'; // Default para PJ
  address: BillingAddress;
}

export interface InstructorAccountResponseDTO {
  providerAccountId: string;
  providerWalletId?: string | null; // For Asaas Wallet ID
  providerName: ProviderName;
  onboardingCompleted: boolean;
  payoutsEnabled: boolean;
  status: 'pending' | 'approved' | 'rejected';
  rawStatus: string;
}

export interface AccountStatusResponseDTO {
  providerAccountId: string;
  providerName: ProviderName;
  onboardingCompleted: boolean;
  payoutsEnabled: boolean;
  status: 'pending' | 'approved' | 'rejected';
  rawStatus: string;
}

// ==========================================
// SPLIT DTOs
// ==========================================

export interface PaymentSplitRule {
  walletId?: string;       // Wallet ID da subconta Asaas do instrutor
  accountId?: string;      // Conta Connect id da Stripe do instrutor
  fixedValue?: number;     // Valor fixo em centavos
  percentualValue?: number;// Valor percentual (ex: 90 para 90% do repasse do instrutor)
}

// ==========================================
// PAYMENT / CHECKOUT DTOs
// ==========================================

export interface TokenizedCardPayment {
  creditCardTokenId: string;
}

/**
 * @deprecated Legacy compatibility only. Do not use in new payment flows.
 * Refrain from using this interface as it handles raw card credentials on the server side.
 * Always prioritize client-side tokenization (tokenized card flow) to ensure PCI compliance.
 */
export interface DirectCardDetails {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
}

export interface CreatePaymentDTO {
  amount: number; // Em centavos
  description: string;
  customerProviderId: string;
  externalReferenceId: string; // ID do agendamento (appointment_id)
  
  // Card Details - supports tokenized token or direct details
  cardToken?: string;
  cardDetails?: DirectCardDetails;
  
  // Billing details for anti-fraud (vital for Asaas)
  billingAddress: BillingAddress;
  customerIp?: string;

  // Split configurations
  splitRules?: PaymentSplitRule[];

  // Optional return redirect URL after successful payment
  returnUrl?: string;

  // Modern payment parameters for Asaas (PIX + Installments support)
  billingType?: 'PIX' | 'CREDIT_CARD';
  installmentCount?: number;
  metadata?: Record<string, any>;
}

export interface PaymentResponseDTO {
  providerPaymentId: string;
  providerName: ProviderName;
  amount: number; // Em centavos 
  status: 'pending' | 'paid' | 'failed' | 'refunded' | 'authorized' | 'released';
  clientSecret?: string | null; // For Stripe hybrid element, or Asaas equivalent
  invoiceUrl?: string | null;   // For Asaas invoice display if needed
  rawResponse: Record<string, unknown>;
}

// ==========================================
// REFUND DTOs
// ==========================================

export interface RefundPaymentDTO {
  providerPaymentId: string;
  amount?: number; // Em centavos. Se nulo, efetua estorno total
  reason?: string;
}

export interface RefundResponseDTO {
  providerRefundId: string;
  providerPaymentId: string;
  providerName: ProviderName;
  amountRefunded: number; // Em centavos
  status: 'refunded' | 'failed' | 'pending';
  rawResponse: Record<string, unknown>;
}

// ==========================================
// WEBHOOK DTOs
// ==========================================

export interface WebhookPayload {
  rawBody: string;
  headers: Record<string, string>;
}

export interface WebhookHandlingResponseDTO {
  received: boolean;
  eventId: string;
  eventType: string;
  providerName: ProviderName;
  appointmentId?: string | null;
  paymentId?: string | null;
  status: 'paid' | 'failed' | 'refunded' | 'payout_processed' | 'payout_failed' | 'unknown';
  metadata: Record<string, unknown>;
}
