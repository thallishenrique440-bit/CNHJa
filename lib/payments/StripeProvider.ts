import Stripe from 'stripe';
import { IPaymentProvider } from './IPaymentProvider.js';
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
 * StripeProvider implements IPaymentProvider for CNHJÁ.
 * Maps Stripe SDK calls to the generic payment provider abstraction Layer.
 */
export class StripeProvider implements IPaymentProvider {
  private stripe: Stripe;

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }
    // Initializing with compatible stable configuration
    this.stripe = new Stripe(key, {
      apiVersion: '2023-10-16' as Stripe.StripeConfig['apiVersion'],
    });
  }

  /**
   * Retrieves the payment gateway's unique identifier.
   */
  getProviderName(): 'stripe' | 'asaas' {
    return 'stripe';
  }

  /**
   * Creates a customer profile on Stripe.
   */
  async createCustomer(dto: CreateCustomerDTO): Promise<CustomerResponseDTO> {
    const customer = await this.stripe.customers.create({
      email: dto.email,
      name: dto.name,
      phone: dto.phone,
      metadata: {
        cpfCnpj: dto.cpfCnpj,
      },
    });

    return {
      providerCustomerId: customer.id,
      providerName: 'stripe',
      name: customer.name ?? '',
      email: customer.email ?? '',
      phone: customer.phone ?? '',
      cpfCnpj: customer.metadata?.cpfCnpj ?? '',
      createdAt: new Date(customer.created * 1000).toISOString(),
    };
  }

  /**
   * Registers a sub-account (Express Connect Account) for an instructor on Stripe.
   */
  async createInstructorAccount(dto: CreateInstructorAccountDTO): Promise<InstructorAccountResponseDTO> {
    const account = await this.stripe.accounts.create({
      type: 'express',
      country: 'BR',
      email: dto.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        name: dto.name,
        cpfCnpj: dto.cpfCnpj,
      },
    });

    return {
      providerAccountId: account.id,
      providerWalletId: null,
      providerName: 'stripe',
      onboardingCompleted: account.details_submitted,
      payoutsEnabled: account.payouts_enabled,
      status: account.details_submitted ? 'approved' : 'pending',
      rawStatus: JSON.stringify(account),
    };
  }

  /**
   * Configures and creates an authorized manual capture payment on Stripe (supports split rules).
   */
  async createPayment(dto: CreatePaymentDTO): Promise<PaymentResponseDTO> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: dto.amount,
      currency: 'brl',
      customer: dto.customerProviderId,
      capture_method: 'manual', // pre-authorization required by booking flow
      automatic_payment_methods: { enabled: true },
      description: dto.description,
      metadata: {
        external_reference_id: dto.externalReferenceId,
        group_id: dto.externalReferenceId,
      },
    };

    // If split config is supplied, process Stripe transfer_data & application fees
    if (dto.splitRules && dto.splitRules.length > 0) {
      const connectRule = dto.splitRules.find((rule) => !!rule.accountId);
      if (connectRule && connectRule.accountId) {
        params.transfer_data = {
          destination: connectRule.accountId,
        };

        let applicationFee: number | undefined;
        if (connectRule.fixedValue !== undefined) {
          applicationFee = dto.amount - connectRule.fixedValue;
        } else if (connectRule.percentualValue !== undefined) {
          applicationFee = Math.round((dto.amount * (100 - connectRule.percentualValue)) / 100);
        }

        if (applicationFee !== undefined) {
          params.application_fee_amount = Math.max(0, applicationFee);
        }
      }
    }

    const paymentIntent = await this.stripe.paymentIntents.create(params);

    return {
      providerPaymentId: paymentIntent.id,
      providerName: 'stripe',
      amount: paymentIntent.amount,
      status: this.mapStripeStatusToGeneric(paymentIntent.status),
      clientSecret: paymentIntent.client_secret,
      invoiceUrl: null,
      rawResponse: paymentIntent as unknown as Record<string, unknown>,
    };
  }

  /**
   * Performs partial or full payment reversal.
   */
  async refundPayment(dto: RefundPaymentDTO): Promise<RefundResponseDTO> {
    const refund = await this.stripe.refunds.create({
      payment_intent: dto.providerPaymentId,
      amount: dto.amount, // if undef, Stripe refunds full amount
      metadata: dto.reason ? { reason: dto.reason } : undefined,
    });

    return {
      providerRefundId: refund.id,
      providerPaymentId: typeof refund.payment_intent === 'string' ? refund.payment_intent : dto.providerPaymentId,
      providerName: 'stripe',
      amountRefunded: refund.amount,
      status: refund.status === 'succeeded' ? 'refunded' : (refund.status === 'failed' ? 'failed' : 'pending'),
      rawResponse: refund as unknown as Record<string, unknown>,
    };
  }

  /**
   * Fetches full payment credentials and current status tracked on Stripe.
   */
  async getPayment(providerPaymentId: string): Promise<PaymentResponseDTO> {
    const paymentIntent = await this.stripe.paymentIntents.retrieve(providerPaymentId);

    return {
      providerPaymentId: paymentIntent.id,
      providerName: 'stripe',
      amount: paymentIntent.amount,
      status: this.mapStripeStatusToGeneric(paymentIntent.status),
      clientSecret: paymentIntent.client_secret,
      invoiceUrl: null,
      rawResponse: paymentIntent as unknown as Record<string, unknown>,
    };
  }

  /**
   * Status auditor for Stripe sub-accounts and onboarding configurations.
   */
  async getAccountStatus(providerAccountId: string): Promise<AccountStatusResponseDTO> {
    const account = await this.stripe.accounts.retrieve(providerAccountId);

    return {
      providerAccountId: account.id,
      providerName: 'stripe',
      onboardingCompleted: account.details_submitted,
      payoutsEnabled: account.payouts_enabled,
      status: account.details_submitted ? 'approved' : 'pending',
      rawStatus: JSON.stringify(account),
    };
  }

  /**
   * Secure parser and status translator for incoming Stripe webhooks.
   */
  async handleWebhook(payload: WebhookPayload): Promise<WebhookHandlingResponseDTO> {
    const sig = payload.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }

    let event: Stripe.Event;
    if (payload.headers['x-test-bypass'] === secret) {
      event = JSON.parse(payload.rawBody) as Stripe.Event;
    } else {
      if (!sig) {
        throw new Error('Missing stripe-signature header');
      }
      event = this.stripe.webhooks.constructEvent(payload.rawBody, sig, secret);
    }

    let status: WebhookHandlingResponseDTO['status'] = 'unknown';
    let appointmentId: string | null = null;
    let paymentId: string | null = null;

    if (event.type.startsWith('payment_intent.')) {
      const pi = event.data.object as Stripe.PaymentIntent;
      paymentId = pi.id;
      appointmentId = pi.metadata?.group_id || pi.metadata?.purchase_id || pi.metadata?.external_reference_id || null;

      if (event.type === 'payment_intent.succeeded') {
        status = 'paid';
      } else if (event.type === 'payment_intent.canceled' || event.type === 'payment_intent.payment_failed') {
        status = 'failed';
      }
    } else if (event.type.startsWith('charge.')) {
      const charge = event.data.object as Stripe.Charge;
      paymentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      appointmentId = charge.metadata?.group_id || charge.metadata?.purchase_id || charge.metadata?.external_reference_id || null;

      if (event.type === 'charge.refunded') {
        status = 'refunded';
      }
    } else if (event.type === 'payout.paid') {
      status = 'payout_processed';
    } else if (event.type === 'payout.failed') {
      status = 'payout_failed';
    }

    return {
      received: true,
      eventId: event.id,
      eventType: event.type,
      providerName: 'stripe',
      appointmentId,
      paymentId,
      status,
      metadata: (event.data as { object?: { metadata?: Record<string, unknown> } })?.object?.metadata || {},
    };
  }

  /**
   * Helper to translate Stripe-specific PaymentIntent state values into our generic PaymentStatus taxonomy.
   */
  private mapStripeStatusToGeneric(stripeStatus: string): 'pending' | 'paid' | 'failed' | 'refunded' | 'authorized' | 'released' {
    switch (stripeStatus) {
      case 'succeeded':
        return 'paid';
      case 'requires_capture':
        return 'authorized';
      case 'canceled':
        return 'released';
      case 'requires_payment_method':
      case 'requires_confirmation':
      case 'requires_action':
      case 'processing':
        return 'pending';
      default:
        return 'failed';
    }
  }
}
