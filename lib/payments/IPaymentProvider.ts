import {
  CreateCustomerDTO,
  CustomerResponseDTO,
  CreateInstructorAccountDTO,
  InstructorAccountResponseDTO,
  CreatePaymentDTO,
  PaymentResponseDTO,
  RefundPaymentDTO,
  RefundResponseDTO,
  AccountStatusResponseDTO,
  WebhookPayload,
  WebhookHandlingResponseDTO,
} from './types.js';

/**
 * IPaymentProvider definitions for CNHJÁ Payment Layer abstraction.
 * Every integrated gateway (Stripe, Asaas, etc.) must implement this interface.
 */
export interface IPaymentProvider {
  /**
   * Retrieves the payment gateway's unique identifier.
   */
  getProviderName(): 'stripe' | 'asaas';

  /**
   * Creates a customer profile on the provider gateway.
   */
  createCustomer(dto: CreateCustomerDTO): Promise<CustomerResponseDTO>;

  /**
   * Registers a sub-account/express connect account for an instructor (PF/PJ).
   */
  createInstructorAccount(dto: CreateInstructorAccountDTO): Promise<InstructorAccountResponseDTO>;

  /**
   * Configures and creates an intent or directly captures a payment (supports split rules).
   */
  createPayment(dto: CreatePaymentDTO): Promise<PaymentResponseDTO>;

  /**
   * Performs partial or full payment reversal.
   */
  refundPayment(dto: RefundPaymentDTO): Promise<RefundResponseDTO>;

  /**
   * Fetches full payment credentials and status tracker.
   */
  getPayment(providerPaymentId: string): Promise<PaymentResponseDTO>;

  /**
   * Status auditor for sub-accounts and onboarding states/withdraw availability.
   */
  getAccountStatus(providerAccountId: string): Promise<AccountStatusResponseDTO>;

  /**
   * Secure parser and handler for incoming gateway webhooks/signatures.
   */
  handleWebhook(payload: WebhookPayload): Promise<WebhookHandlingResponseDTO>;
}
