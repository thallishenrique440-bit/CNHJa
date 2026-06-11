import { IPaymentProvider } from './IPaymentProvider';
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
} from './types';

// ==========================================
// ASAAS SPECIFIC API SHAPES
// ==========================================

export interface AsaasCustomerPayload {
  name: string;
  email: string;
  phone: string;
  cpfCnpj: string;
  notificationDisabled: boolean;
  address?: string;
  addressNumber?: string;
  complement?: string;
  province?: string;
  postalCode?: string;
}

export interface AsaasCustomerResponse {
  id: string;
  name: string;
  email: string;
  phone: string;
  cpfCnpj: string;
  dateCreated: string;
}

export interface AsaasAccountPayload {
  name: string;
  email: string;
  cpfCnpj: string;
  phone: string;
  mobilePhone?: string;
  address?: string;
  addressNumber?: string;
  complement?: string;
  province?: string;
  postalCode?: string;
  companyType?: 'INDIVIDUAL' | 'MEI' | 'LIMITED' | 'ASSOCIATION';
}

export interface AsaasAccountResponse {
  id: string;
  walletId: string;
  apiKey: string;
  status?: string;
}

export interface AsaasAccountsListResponse {
  data?: Array<{
    id: string;
    walletId: string;
    status: string;
    onboardingCompleted?: boolean;
    payoutsEnabled?: boolean;
  }>;
}

export interface AsaasCreditCard {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
}

export interface AsaasCreditCardHolderInfo {
  name: string;
  email: string;
  cpfCnpj: string;
  postalCode: string;
  addressNumber: string;
  addressComplement?: string;
  phone: string;
}

export interface AsaasSplitRulePayload {
  walletId: string;
  fixedValue?: number;
  percentualValue?: number;
}

export interface AsaasPaymentPayload {
  customer: string;
  billingType: 'CREDIT_CARD';
  value: number;
  dueDate: string;
  description: string;
  externalReference: string;
  creditCardToken?: string;
  creditCard?: AsaasCreditCard;
  creditCardHolderInfo: AsaasCreditCardHolderInfo;
  remoteIp?: string;
  split?: AsaasSplitRulePayload[];
}

export interface AsaasPaymentResponse {
  id: string;
  value: number;
  status: string;
  invoiceUrl?: string;
  clientSecret?: string;
}

export interface AsaasRefundResponse {
  id: string;
  status: string;
  value: number;
}

export interface AsaasWebhookBody {
  id?: string;
  event: string;
  payment?: {
    id: string;
    customer: string;
    value: number;
    externalReference: string;
    status: string;
  };
}

/**
 * AsaasProvider implements IPaymentProvider for CNHJÁ.
 * Maps Asaas API v3 calls to the generic payment provider abstraction layer.
 * Focus exclusively on CREDIT_CARD payments; clean design with zero business logic fallbacks.
 */
export class AsaasProvider implements IPaymentProvider {
  private apiKey: string;
  private apiUrl: string;

  constructor() {
    const key = process.env.ASAAS_API_KEY;
    if (!key) {
      throw new Error('ASAAS_API_KEY environment variable is required');
    }
    this.apiKey = key;
    this.apiUrl = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';
  }

  /**
   * Safe, type-strict fetch wrapper for Asaas HTTP calls.
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${this.apiUrl}${cleanEndpoint}`;
    
    const headers = {
      'access_token': this.apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorsList: string = 'Unknown Asaas API error';
      try {
        const errorJson = JSON.parse(errorText) as { errors?: Array<{ description: string }> };
        if (errorJson.errors && errorJson.errors.length > 0) {
          errorsList = errorJson.errors.map(err => err.description).join(', ');
        }
      } catch {
        errorsList = errorText;
      }
      throw new Error(`Asaas API error [${response.status}]: ${errorsList}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Retrieves the payment gateway's unique identifier.
   */
  getProviderName(): 'stripe' | 'asaas' {
    return 'asaas';
  }

  /**
   * Creates a customer profile on Asaas.
   */
  async createCustomer(dto: CreateCustomerDTO): Promise<CustomerResponseDTO> {
    const payload: AsaasCustomerPayload = {
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      cpfCnpj: dto.cpfCnpj,
      notificationDisabled: true,
    };

    if (dto.address) {
      payload.address = dto.address.address;
      payload.addressNumber = dto.address.addressNumber;
      payload.complement = dto.address.complement;
      payload.province = dto.address.province;
      payload.postalCode = dto.address.postalCode;
    }

    const response = await this.request<AsaasCustomerResponse>('/customers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      providerCustomerId: response.id,
      providerName: 'asaas',
      name: response.name,
      email: response.email,
      phone: response.phone,
      cpfCnpj: response.cpfCnpj,
      createdAt: response.dateCreated,
    };
  }

  /**
   * Registers a subaccount for an instructor on Asaas.
   */
  async createInstructorAccount(dto: CreateInstructorAccountDTO): Promise<InstructorAccountResponseDTO> {
    const payload: AsaasAccountPayload = {
      name: dto.name,
      email: dto.email,
      cpfCnpj: dto.cpfCnpj,
      phone: dto.phone,
      mobilePhone: dto.phone,
      address: dto.address.address,
      addressNumber: dto.address.addressNumber,
      complement: dto.address.complement,
      province: dto.address.province,
      postalCode: dto.address.postalCode,
      companyType: dto.companyType || 'INDIVIDUAL',
    };

    const response = await this.request<AsaasAccountResponse>('/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      providerAccountId: response.id,
      providerWalletId: response.walletId,
      providerName: 'asaas',
      onboardingCompleted: false, // Onboarding/KYC starts pending for newly created subaccounts on Asaas
      payoutsEnabled: false,
      status: 'pending',
      rawStatus: JSON.stringify(response),
    };
  }

  /**
   * Creates a credit card payment on Asaas (supports client-side tokens or fallback details, plus splits).
   */
  async createPayment(dto: CreatePaymentDTO): Promise<PaymentResponseDTO> {
    // To ensure accurate creditCardHolderInfo without asking for redundant inputs, 
    // we query clean profile records from the Customer creation ID directly.
    const customer = await this.request<AsaasCustomerResponse>(`/customers/${dto.customerProviderId}`);
    
    const creditCardHolderInfo: AsaasCreditCardHolderInfo = {
      name: dto.cardDetails?.holderName || customer.name,
      email: customer.email,
      cpfCnpj: customer.cpfCnpj,
      postalCode: dto.billingAddress.postalCode.replace(/\D/g, ''),
      addressNumber: dto.billingAddress.addressNumber,
      addressComplement: dto.billingAddress.complement,
      phone: customer.phone,
    };

    const todayStr = new Date().toISOString().split('T')[0];

    const paymentPayload: AsaasPaymentPayload = {
      customer: dto.customerProviderId,
      billingType: 'CREDIT_CARD',
      value: dto.amount / 100, // Asaas accepts BRL decimals instead of raw cents
      dueDate: todayStr,
      description: dto.description,
      externalReference: dto.externalReferenceId,
      creditCardHolderInfo,
    };

    if (dto.cardToken) {
      paymentPayload.creditCardToken = dto.cardToken;
    } else if (dto.cardDetails) {
      paymentPayload.creditCard = {
        holderName: dto.cardDetails.holderName,
        number: dto.cardDetails.number,
        expiryMonth: dto.cardDetails.expiryMonth,
        expiryYear: dto.cardDetails.expiryYear,
        ccv: dto.cardDetails.ccv,
      };
    }

    // Apply strict platform splits if configured in payload
    if (dto.splitRules && dto.splitRules.length > 0) {
      paymentPayload.split = dto.splitRules
        .filter(rule => !!rule.walletId) // In Asaas, walletId holds references to target instructor wallets
        .map(rule => {
          const splitRule: AsaasSplitRulePayload = {
            walletId: rule.walletId as string,
          };
          if (rule.fixedValue !== undefined) {
            splitRule.fixedValue = rule.fixedValue / 100; // Raw cents to BRL decimal
          } else if (rule.percentualValue !== undefined) {
            splitRule.percentualValue = rule.percentualValue;
          }
          return splitRule;
        });
    }

    if (dto.customerIp) {
      paymentPayload.remoteIp = dto.customerIp;
    }

    const response = await this.request<AsaasPaymentResponse>('/payments', {
      method: 'POST',
      body: JSON.stringify(paymentPayload),
    });

    return {
      providerPaymentId: response.id,
      providerName: 'asaas',
      amount: Math.round(response.value * 100),
      status: this.mapAsaasStatusToGeneric(response.status),
      clientSecret: null,
      invoiceUrl: response.invoiceUrl || null,
      rawResponse: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Refuses / reverses a payment in Asaas.
   */
  async refundPayment(dto: RefundPaymentDTO): Promise<RefundResponseDTO> {
    const refundPayload: { value?: number; description?: string } = {};
    if (dto.amount !== undefined) {
      refundPayload.value = dto.amount / 100;
    }
    if (dto.reason) {
      refundPayload.description = dto.reason;
    }

    const response = await this.request<AsaasRefundResponse>(`/payments/${dto.providerPaymentId}/refund`, {
      method: 'POST',
      body: JSON.stringify(refundPayload),
    });

    return {
      providerRefundId: response.id,
      providerPaymentId: dto.providerPaymentId,
      providerName: 'asaas',
      amountRefunded: Math.round(response.value * 100),
      status: response.status === 'REFUNDED' ? 'refunded' : 'pending',
      rawResponse: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Queries precise charge state on Asaas.
   */
  async getPayment(providerPaymentId: string): Promise<PaymentResponseDTO> {
    const response = await this.request<AsaasPaymentResponse>(`/payments/${providerPaymentId}`);

    return {
      providerPaymentId: response.id,
      providerName: 'asaas',
      amount: Math.round(response.value * 100),
      status: this.mapAsaasStatusToGeneric(response.status),
      clientSecret: null,
      invoiceUrl: response.invoiceUrl || null,
      rawResponse: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Audits subaccount KYC and configuration status on Asaas.
   */
  async getAccountStatus(providerAccountId: string): Promise<AccountStatusResponseDTO> {
    const response = await this.request<AsaasAccountsListResponse>(`/accounts?id=${providerAccountId}`);
    const accountInfo = response.data?.find(acc => acc.id === providerAccountId) || response.data?.[0];

    if (!accountInfo) {
      throw new Error(`Asaas subaccount not found: ${providerAccountId}`);
    }

    const asaasStatus = (accountInfo.status || '').toUpperCase();
    let status: AccountStatusResponseDTO['status'] = 'pending';
    let onboardingCompleted = false;
    let payoutsEnabled = false;

    if (asaasStatus === 'APPROVED' || asaasStatus === 'APROVADO' || asaasStatus === 'ACTIVE' || asaasStatus === 'ATIVO') {
      status = 'approved';
      onboardingCompleted = true;
      payoutsEnabled = true;
    } else if (asaasStatus === 'REJECTED' || asaasStatus === 'REJEITADO') {
      status = 'rejected';
    }

    return {
      providerAccountId: accountInfo.id,
      providerName: 'asaas',
      onboardingCompleted,
      payoutsEnabled,
      status,
      rawStatus: JSON.stringify(accountInfo),
    };
  }

  /**
   * Decodes incoming webhooks securely mapping payload elements.
   */
  async handleWebhook(payload: WebhookPayload): Promise<WebhookHandlingResponseDTO> {
    const secret = process.env.ASAAS_WEBHOOK_SECRET;
    const receivedToken = payload.headers['asaas-access-token'];

    if (secret && receivedToken !== secret) {
      throw new Error('Invalid Asaas access token signature');
    }

    const body = JSON.parse(payload.rawBody) as AsaasWebhookBody;
    
    let status: WebhookHandlingResponseDTO['status'] = 'unknown';
    let paymentId: string | null = null;
    let appointmentId: string | null = null;

    if (body.payment) {
      paymentId = body.payment.id;
      appointmentId = body.payment.externalReference || null;
    }

    const asaasEvent = (body.event || '').toUpperCase();
    if (asaasEvent === 'PAYMENT_RECEIVED' || asaasEvent === 'PAYMENT_CONFIRMED') {
      status = 'paid';
    } else if (asaasEvent === 'PAYMENT_REFUNDED') {
      status = 'refunded';
    } else if (asaasEvent === 'PAYMENT_OVERDUE' || asaasEvent === 'PAYMENT_FAILED') {
      status = 'failed';
    }

    return {
      received: true,
      eventId: body.id || `${body.event}_${body.payment?.id || Date.now()}`,
      eventType: body.event,
      providerName: 'asaas',
      appointmentId,
      paymentId,
      status,
      metadata: {},
    };
  }

  /**
   * Generic Status Translation mechanism.
   */
  private mapAsaasStatusToGeneric(asaasStatus: string): 'pending' | 'paid' | 'failed' | 'refunded' | 'authorized' | 'released' {
    switch (asaasStatus.toUpperCase()) {
      case 'CONFIRMED':
      case 'RECEIVED':
        return 'paid';
      case 'AUTHORIZED':
        return 'authorized';
      case 'PENDING':
        return 'pending';
      case 'REFUNDED':
      case 'PARTIALLY_REFUNDED':
        return 'refunded';
      case 'OVERDUE':
      case 'REFUND_REQUESTED':
      case 'CHARGEBACK_REQUESTED':
        return 'failed';
      default:
        return 'failed';
    }
  }
}
