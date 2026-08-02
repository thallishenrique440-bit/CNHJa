import { IPaymentProvider } from './IPaymentProvider.js';

const MAX_INSTALLMENTS = 4;
import {
  CreateCustomerDTO,
  CustomerResponseDTO,
  CreateInstructorAccountDTO,
  InstructorAccountResponseDTO,
  CreatePaymentDTO,
  PaymentResponseDTO,
  InstallmentPaymentItemDTO,
  RefundPaymentDTO,
  RefundResponseDTO,
  AccountStatusResponseDTO,
  WebhookPayload,
  WebhookHandlingResponseDTO,
} from './types.js';

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
  totalFixedValue?: number;
}

export interface AsaasPaymentPayload {
  customer: string;
  billingType: 'CREDIT_CARD' | 'PIX';
  value?: number;
  totalValue?: number;
  installmentCount?: number;
  dueDate: string;
  description: string;
  externalReference: string;
  creditCardToken?: string;
  creditCard?: AsaasCreditCard;
  creditCardHolderInfo?: AsaasCreditCardHolderInfo;
  remoteIp?: string;
  split?: AsaasSplitRulePayload[];
  callback?: {
    successUrl: string;
    autoRedirect: boolean;
  };
  metadata?: Record<string, any>;
}

export interface AsaasPaymentResponse {
  id: string;
  value?: number;
  totalValue?: number;
  status: string;
  invoiceUrl?: string;
  clientSecret?: string;
  installment?: string;
}

export interface AsaasInstallmentPaymentResponseItem {
  id: string;
  installmentNumber: number;
  value: number;
  netValue?: number;
  dueDate?: string;
  status?: string;
}

export interface AsaasInstallmentPaymentsListResponse {
  object?: string;
  hasMore?: boolean;
  totalCount?: number;
  limit?: number;
  offset?: number;
  data: AsaasInstallmentPaymentResponseItem[];
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
    
    console.log('================ [ASAAS AUDIT OUTCOMING] ================');
    console.log('[ASAAS API URL]:', url);
    console.log('[ASAAS BASE]:', this.apiUrl);
    console.log('[ASAAS METHOD]:', options.method || 'GET');
    console.log('=========================================================');

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

      console.error('================ [ASAAS AUDIT ERROR] ================');
      console.error('[STATUS HTTP]:', response.status);
      console.error('[REQUESTED URL]:', url);
      console.error('[RESPONSE BODY]:', errorText);
      console.error('[API KEY CONFIGURADA]:', this.apiKey ? `SIM (${this.apiKey.substring(0,8)}...)` : 'NÃO');
      console.error('=====================================================');

      let errorsList: string = 'Unknown Asaas API error';
      let firstErrorCode: string | undefined = undefined;
      try {
        const errorJson = JSON.parse(errorText) as { errors?: Array<{ code?: string; description: string }> };
        if (errorJson.errors && errorJson.errors.length > 0) {
          errorsList = errorJson.errors.map(err => err.description).join(', ');
          firstErrorCode = errorJson.errors[0]?.code;
        }
      } catch {
        errorsList = errorText;
      }
      const err = new Error(`Asaas API error [${response.status}]: ${errorsList}`) as Error & { code?: string; rawError?: string };
      if (firstErrorCode) {
        err.code = firstErrorCode;
      }
      err.rawError = errorText;
      throw err;
    }

    const responseClone = response.clone();
    const successText = await responseClone.text();

    console.log('================ [ASAAS AUDIT SUCCESS] ================');
    console.log('[STATUS HTTP]:', response.status);
    console.log('[REQUESTED URL]:', url);
    console.log('[RESPONSE BODY]:', successText);
    console.log('=======================================================');

    return response.json() as Promise<T>;
  }

  /**
   * Retrieves the payment gateway's unique identifier.
   */
  getProviderName(): 'asaas' {
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
   * Creates a credit card or PIX payment on Asaas (supports client-side tokens, installments, plus splits).
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
      billingType: dto.billingType || 'CREDIT_CARD',
      dueDate: todayStr,
      description: dto.description,
      externalReference: dto.externalReferenceId,
    };

    if (dto.installmentCount && dto.installmentCount > MAX_INSTALLMENTS) {
      throw new Error(`O parcelamento não pode exceder ${MAX_INSTALLMENTS} vezes.`);
    }

    if (paymentPayload.billingType === 'CREDIT_CARD') {
      paymentPayload.creditCardHolderInfo = creditCardHolderInfo;
      if (dto.installmentCount && dto.installmentCount > 1) {
        paymentPayload.installmentCount = dto.installmentCount;
        paymentPayload.totalValue = dto.amount / 100;
      } else {
        paymentPayload.value = dto.amount / 100;
      }

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
    } else {
      // For PIX, just use the flat value field
      paymentPayload.value = dto.amount / 100;
    }

    // Apply strict platform splits if configured in payload
    if (dto.splitRules && dto.splitRules.length > 0) {
      const isInstallment = dto.billingType === 'CREDIT_CARD' && !!(dto.installmentCount && dto.installmentCount > 1);
      paymentPayload.split = dto.splitRules
        .filter(rule => !!rule.walletId) // In Asaas, walletId holds references to target instructor wallets
        .map(rule => {
          const splitRule: AsaasSplitRulePayload = {
            walletId: rule.walletId as string,
          };
          if (rule.fixedValue !== undefined) {
            if (isInstallment) {
              splitRule.totalFixedValue = rule.fixedValue / 100; // Raw cents to BRL decimal total for the installment
            } else {
              splitRule.fixedValue = rule.fixedValue / 100; // Raw cents to BRL decimal per payment
            }
          } else if (rule.percentualValue !== undefined) {
            splitRule.percentualValue = rule.percentualValue;
          }
          return splitRule;
        });
    }

    if (dto.customerIp) {
      paymentPayload.remoteIp = dto.customerIp;
    }

    if (dto.returnUrl) {
      paymentPayload.callback = {
        successUrl: dto.returnUrl,
        autoRedirect: true,
      };
    }

    if (dto.metadata) {
      paymentPayload.metadata = dto.metadata;
    }

    // Temporary audit logs for observability
    if (paymentPayload.split && paymentPayload.split.length > 0) {
      paymentPayload.split.forEach(splitRule => {
        const matchingRule = dto.splitRules?.find(r => r.walletId === splitRule.walletId);
        const installmentCount = dto.installmentCount || 1;
        const internalFixedValue = matchingRule?.fixedValue;
        console.log(`[ASAAS SPLIT AUDIT]
installmentCount: ${installmentCount}
walletId: ${splitRule.walletId}
internalFixedValue: ${internalFixedValue !== undefined ? internalFixedValue : 'undefined'}
payloadSplit:
${JSON.stringify(splitRule, null, 2)}`);
      });
    }

    const response = await this.request<any>('/payments', {
      method: 'POST',
      body: JSON.stringify(paymentPayload),
    });

    // 1. Parse initial response
    let parsed = this.parseAsaasResponse(response, dto.amount);

    // 2. Check if invoiceUrl is already valid
    if (this.isValidInvoiceUrl(parsed.invoiceUrl)) {
      console.log('[ASAAS INTEGRATION] Valid invoiceUrl found in primary response. Returning immediately.');
      return parsed;
    }

    // 3. Fallback: retrieve invoiceUrl via installment endpoint if installmentId is present
    const rawInstallmentId = response.installment || response.installmentId || null;
    if (rawInstallmentId) {
      console.log(`[ASAAS INTEGRATION] Primary invoiceUrl missing/invalid. Attempting fallback via installment ID: ${rawInstallmentId}`);
      try {
        const listResponse = await this.request<any>(`/installments/${rawInstallmentId}/payments`);
        const paymentsList = listResponse?.data;

        if (Array.isArray(paymentsList) && paymentsList.length > 0) {
          const selectedPayment = this.selectEligibleInstallmentPayment(paymentsList);
          if (selectedPayment) {
            console.log(`[ASAAS INTEGRATION] Selected payment ${selectedPayment.id} for installment checkout.`);
            // Parse the selected payment as our primary response
            parsed = this.parseAsaasResponse(selectedPayment, dto.amount);
            parsed.rawResponse = {
              createPaymentResponse: response,
              installmentLookupResponse: listResponse,
              selectedInstallmentPayment: selectedPayment,
            };
          }
        }
      } catch (fallbackError) {
        console.error('[ASAAS INTEGRATION] Failed to retrieve installment payments fallback:', fallbackError);
        // Fallback: keep the original parsed object (the app will handle missing URL gracefully if it occurs)
      }
    }

    return parsed;
  }

  /**
   * Helper to strictly validate an invoiceUrl.
   */
  private isValidInvoiceUrl(url?: string | null): boolean {
    if (!url) return false;
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (trimmed === '') return false;
    try {
      const parsedUrl = new URL(trimmed);
      return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Selection strategy for choosing the most appropriate payment within an installment group.
   * Priority 1: First payment that is officially unpaid and waiting for payment (status PENDING).
   * Priority 2: First payment that contains a valid invoiceUrl for checkout.
   * Priority 3: Ultimate fallback to the first element in the list (payments[0]).
   */
  private selectEligibleInstallmentPayment(payments: any[]): any {
    if (!payments || payments.length === 0) {
      return null;
    }

    // Priority 1: First payment with status 'PENDING' (officially unpaid/awaiting payment)
    const pendingPayment = payments.find(p => p && typeof p.status === 'string' && p.status.toUpperCase() === 'PENDING');
    if (pendingPayment) {
      return pendingPayment;
    }

    // Priority 2: First payment with a valid invoice URL (proven checkout capability)
    const validUrlPayment = payments.find(p => p && this.isValidInvoiceUrl(p.invoiceUrl));
    if (validUrlPayment) {
      return validUrlPayment;
    }

    // Priority 3: Ultimate fallback to the first element in the list
    return payments[0];
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

    return this.parseAsaasResponse(response);
  }

  /**
   * Identifies whether an error is transient (eligible for retry) or definitive.
   * Transient: network errors, timeouts, HTTP 429, 500, 502, 503, 504.
   * Definitive: local validation/consistency errors, HTTP 400, 401, 403, 404, invalid parameters.
   */
  private isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const message = err.message || '';

    // Local validation and consistency errors must fail fast
    if (message.includes('Inconsistência') || message.includes('required') || message.includes('Esperado')) {
      return false;
    }

    // Parse HTTP status if formatted as "Asaas API error [STATUS]: ..."
    const statusMatch = message.match(/Asaas API error \[(\d+)\]/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      // Transient HTTP status codes
      if ([429, 500, 502, 503, 504].includes(status)) {
        return true;
      }
      // Definitive HTTP status codes (400, 401, 403, 404, etc.)
      return false;
    }

    // Network level issues (fetch errors, timeouts, etc.) are transient
    return true;
  }

  /**
   * Fetches all individual payments for an installment collection from Asaas.
   * Includes exponential backoff retry mechanism (transient errors only) and strict sequence validation (1..N).
   */
  async getInstallmentPayments(
    installmentId: string,
    expectedCount?: number
  ): Promise<InstallmentPaymentItemDTO[]> {
    if (!installmentId) {
      throw new Error('installmentId is required to fetch installment payments');
    }

    const maxAttempts = 3;
    const delays = [300, 600, 1000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.request<AsaasInstallmentPaymentsListResponse>(`/installments/${installmentId}/payments?limit=100`);
        const payments = response?.data || [];

        if (expectedCount && payments.length < expectedCount && attempt < maxAttempts) {
          console.warn(`⚠️ [AsaasProvider] Attempt ${attempt}/${maxAttempts}: Expected ${expectedCount} installment payments, received ${payments.length}. Retrying in ${delays[attempt - 1]}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
          continue;
        }

        // Validate total count match
        if (expectedCount && payments.length !== expectedCount) {
          throw new Error(`Inconsistência no parcelamento Asaas: Esperado ${expectedCount} parcelas, retornado ${payments.length}`);
        }

        // Sort by installmentNumber ascending
        payments.sort((a, b) => (a.installmentNumber || 0) - (b.installmentNumber || 0));

        // Validate sequential installment numbers 1..N without gaps or duplicates
        if (expectedCount) {
          const numbers = payments.map((p) => p.installmentNumber);
          const expectedSequence = Array.from({ length: expectedCount }, (_, i) => i + 1);

          for (let i = 0; i < expectedCount; i++) {
            if (numbers[i] !== expectedSequence[i]) {
              throw new Error(
                `Inconsistência na sequência de parcelas Asaas: Esperado [${expectedSequence.join(', ')}], recebido [${numbers.join(', ')}]`
              );
            }
          }
        }

        return payments.map((p) => ({
          id: p.id,
          installmentNumber: p.installmentNumber,
          value: p.value,
          netValue: p.netValue,
          dueDate: p.dueDate,
          status: p.status,
        }));
      } catch (err: unknown) {
        if (attempt === maxAttempts || !this.isTransientError(err)) {
          throw err;
        }
        console.warn(`⚠️ [AsaasProvider] Attempt ${attempt}/${maxAttempts} failed with transient error: ${(err as Error).message}. Retrying in ${delays[attempt - 1]}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      }
    }

    throw new Error(`Falha ao obter parcelas do parcelamento '${installmentId}' no Asaas`);
  }

  /**
   * Resiliently parses any Asaas API response (payment or installment) to a generic PaymentResponseDTO.
   */
  private parseAsaasResponse(response: AsaasPaymentResponse, fallbackAmountCents: number = 0): PaymentResponseDTO {
    if (!response) {
      throw new Error('Empty response from Asaas API');
    }

    const providerPaymentId = response.id || '';
    const providerInstallmentId = response.installment || null;

    // Resilient value extraction (Asaas returns decimals, our system expects cents)
    let amountCents = fallbackAmountCents;
    if (typeof response.value === 'number') {
      amountCents = Math.round(response.value * 100);
    } else if (typeof response.totalValue === 'number') {
      amountCents = Math.round(response.totalValue * 100);
    }

    // Resilient status mapping
    const rawStatus = response.status;
    const status = this.mapAsaasStatusToGeneric(rawStatus);

    // Resilient invoiceUrl extraction
    const invoiceUrl = response.invoiceUrl || null;

    return {
      providerPaymentId,
      providerName: 'asaas',
      providerInstallmentId,
      amount: amountCents,
      status,
      clientSecret: null,
      invoiceUrl,
      rawResponse: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Audits subaccount KYC and configuration status on Asaas.
   */
  async getAccountStatus(providerAccountId: string): Promise<AccountStatusResponseDTO> {
    const response = await this.request<AsaasAccountResponse>(`/accounts/${providerAccountId}`);

    if (!response) {
      throw new Error(`Asaas subaccount not found: ${providerAccountId}`);
    }

    const asaasStatus = (response.status || '').toUpperCase();
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
      providerAccountId: response.id,
      providerName: 'asaas',
      onboardingCompleted,
      payoutsEnabled,
      status,
      rawStatus: JSON.stringify(response),
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
  private mapAsaasStatusToGeneric(asaasStatus?: string | null): 'pending' | 'paid' | 'failed' | 'refunded' | 'authorized' | 'released' {
    if (!asaasStatus || typeof asaasStatus !== 'string') {
      return 'pending';
    }
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
