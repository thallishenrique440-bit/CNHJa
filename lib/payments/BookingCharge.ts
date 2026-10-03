// FASE 3 — criacao da cobranca de um agendamento, compartilhada pelo fluxo atual
// (`api/create-booking-intent.ts`, compra direta) e pelo novo fluxo (pagamento
// depois do aceite). As regras abaixo foram MOVIDAS do create-booking-intent sem
// alteracao: tarifa do gateway (P-1.16A), comissao de 10%, split do instrutor,
// recuperacao de cliente invalido no Asaas e cronograma de parcelas (P-1.18E).
// Existe uma unica implementacao: os dois fluxos cobram exatamente do mesmo jeito.

import { buildAppliedFeeSnapshot, quoteCheckout } from './GatewayFeeModel.js';
import { InstallmentService } from './InstallmentService.js';

/** Comissao da plataforma sobre o valor do servico (sem a tarifa do gateway). */
export const PLATFORM_COMMISSION_RATE = 0.10;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface BookingChargeQuote {
  feeQuote: Any;
  appliedFee: Any;
  /** Tarifa do gateway cobrada do aluno (centavos). */
  processingFee: number;
  /** Valor total cobrado: servico + tarifa. */
  totalPriceWithFee: number;
  /** Comissao da plataforma (centavos). */
  applicationFeeAmount: number;
  /** Parte do instrutor no split (centavos). */
  instructorNetCents: number;
  /** Asaas sem faixa de tarifa para o metodo/parcelamento: nao cobrar. */
  ruleMissing: boolean;
}

export function computeBookingCharge(p: {
  finalPriceCents: number;
  paymentMethod: string | undefined | null;
  installmentCount: number | undefined | null;
  providerName: string;
  rules: Any;
}): BookingChargeQuote {
  const feeQuote = quoteCheckout({
    servicePriceCents: p.finalPriceCents,
    method: p.paymentMethod === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'PIX',
    installmentCount: p.installmentCount || 1,
    provider: p.providerName,
    rules: p.rules,
  });
  const processingFee = p.providerName === 'asaas' ? feeQuote.gatewayFeeExpectedCents : 0;
  const applicationFeeAmount = Math.round(p.finalPriceCents * PLATFORM_COMMISSION_RATE);
  return {
    feeQuote,
    appliedFee: buildAppliedFeeSnapshot(feeQuote),
    processingFee,
    totalPriceWithFee: p.finalPriceCents + processingFee,
    applicationFeeAmount,
    instructorNetCents: p.finalPriceCents - applicationFeeAmount,
    ruleMissing: p.providerName === 'asaas' && !feeQuote.rule,
  };
}

export function buildBookingPaymentDTO(p: {
  charge: BookingChargeQuote;
  finalPriceCents: number;
  groupId: string;
  customerProviderId: string;
  returnUrl: string;
  paymentMethod: string | undefined | null;
  installmentCount: number | undefined | null;
  instructorWalletId: string | null | undefined;
}) {
  return {
    amount: p.charge.totalPriceWithFee,
    description: `Agendamento - Código da reserva ${p.groupId}`,
    customerProviderId: p.customerProviderId,
    externalReferenceId: p.groupId,
    returnUrl: p.returnUrl,
    billingAddress: {
      postalCode: '01001-000',
      address: 'Praca da Se',
      addressNumber: '1',
      city: 'Sao Paulo',
      state: 'SP',
    },
    billingType: p.paymentMethod, // e.g., 'PIX' or 'CREDIT_CARD'
    installmentCount: p.installmentCount, // e.g., 1 to 12
    splitRules: [
      {
        walletId: p.instructorWalletId || undefined,
        fixedValue: p.charge.instructorNetCents,
      }
    ],
    metadata: {
      lesson_price: p.finalPriceCents,
      processing_fee: p.charge.processingFee,
      gateway: 'asaas',
      installments: p.installmentCount || 1,
      payment_method: p.paymentMethod === 'CREDIT_CARD' ? 'credit_card' : 'pix'
    }
  };
}

/**
 * Checks if an error is a recognized Asaas invalid_customer error
 */
export function isInvalidCustomerError(err: Any): boolean {
  if (!err) return false;
  if (err.code === 'invalid_customer') return true;
  const msg = String(err.message || err.rawError || err || '').toLowerCase();
  return msg.includes('invalid_customer') || msg.includes('cliente removido') || msg.includes('cliente foi removido');
}

interface RecoverCustomerParams {
  paymentProvider: Any;
  supabase: Any;
  providerName: string;
  secureStudentId: string;
  oldCustomerProviderId: string;
  userEmail: string;
  fullName: string;
  phone: string;
  cpf: string;
  originalError: Any;
}

/**
 * Encapsulated private function to recover an invalid Asaas Customer:
 * 1. Re-creates Customer on provider using user details
 * 2. Validates new providerCustomerId
 * 3. Updates profiles.provider_customer_id in Supabase
 * Returns new providerCustomerId on success or throws originalError on failure.
 */
export async function recoverInvalidCustomer(params: RecoverCustomerParams): Promise<string> {
  const {
    paymentProvider,
    supabase,
    providerName,
    secureStudentId,
    oldCustomerProviderId,
    userEmail,
    fullName,
    phone,
    cpf,
    originalError,
  } = params;

  console.warn(`[ASAAS CUSTOMER RECOVERY] Detected invalid_customer error on payment creation. Initiating controlled recovery.
- providerName: ${providerName}
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- moment: ${new Date().toISOString()}
- originalError: ${originalError?.message || originalError}`);

  // PASSO 1: Re-create Customer on provider using identical student data
  let newCustomerResponse;
  try {
    newCustomerResponse = await paymentProvider.createCustomer({
      email: userEmail || '',
      name: fullName || userEmail || 'Aluno',
      phone: phone.replace(/\D/g, ''),
      cpfCnpj: cpf.replace(/\D/g, ''),
    });
    console.log(`[ASAAS CUSTOMER RECOVERY] Customer re-created successfully on ${providerName}:
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- newProviderCustomerId: ${newCustomerResponse?.providerCustomerId}
- recreationResult: SUCCESS`);
  } catch (recreateError: Any) {
    console.error(`[ASAAS CUSTOMER RECOVERY] Re-creation of Customer failed on ${providerName}:
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- recreationResult: FAILED
- error: ${recreateError?.message || recreateError}`);
    throw originalError; // Abort recovery, preserve original error
  }

  const newCustomerProviderId = newCustomerResponse?.providerCustomerId;
  if (!newCustomerProviderId || typeof newCustomerProviderId !== 'string' || newCustomerProviderId.trim() === '') {
    console.error(`[ASAAS CUSTOMER RECOVERY] Re-created Customer ID is invalid or empty:
- userId: ${secureStudentId}
- receivedId: ${newCustomerProviderId}`);
    throw originalError;
  }

  // PASSO 2: Update profiles.provider_customer_id ONLY after success
  const { error: updateProfileError } = await supabase
    .from('profiles')
    .update({ provider_customer_id: newCustomerProviderId })
    .eq('id', secureStudentId);

  if (updateProfileError) {
    console.error(`[ASAAS CUSTOMER RECOVERY] Failed to update profiles.provider_customer_id in database:
- userId: ${secureStudentId}
- newProviderCustomerId: ${newCustomerProviderId}
- dbUpdateResult: FAILED
- error: ${updateProfileError.message}`);
    throw originalError;
  }

  console.log(`[ASAAS CUSTOMER RECOVERY] Updated profiles.provider_customer_id in DB:
- userId: ${secureStudentId}
- oldProviderCustomerId: ${oldCustomerProviderId}
- newProviderCustomerId: ${newCustomerProviderId}
- dbUpdateResult: SUCCESS`);

  return newCustomerProviderId;
}

/**
 * Garante o cliente do aluno no provedor (reaproveita o salvo no perfil ou
 * cria um novo e grava no perfil). Devolve o id ou lanca o erro do provedor.
 */
export async function ensureProviderCustomer(p: {
  supabase: Any;
  paymentProvider: Any;
  providerName: string;
  studentId: string;
  userEmail: string;
  profile: { full_name?: string | null; provider_customer_id?: string | null; provider_name?: string | null; phone: string; cpf: string };
}): Promise<string> {
  const { supabase, paymentProvider, providerName, studentId, profile } = p;
  let customerProviderId = (profile.provider_name === providerName)
    ? profile.provider_customer_id
    : null;

  if (!customerProviderId) {
    console.log(`[INFO] Creating new Customer via resolved provider: ${providerName} for user ${studentId}`);
    const customerResponse = await paymentProvider.createCustomer({
      email: p.userEmail || '',
      name: profile.full_name || p.userEmail || 'Aluno',
      phone: profile.phone.replace(/\D/g, ''),
      cpfCnpj: profile.cpf.replace(/\D/g, ''),
    });

    customerProviderId = customerResponse.providerCustomerId;
    console.log(`[INFO] Customer created successfully on ${providerName} with ID: ${customerProviderId}`);

    // Persist back to profile
    const { error: updateProfileError } = await supabase
      .from('profiles')
      .update({ provider_customer_id: customerProviderId, provider_name: providerName })
      .eq('id', studentId);

    if (updateProfileError) {
      console.error(`[ERROR] Failed to save customer_id ${customerProviderId} to user profile ${studentId}:`, updateProfileError);
    } else {
      console.log(`[INFO] Saved customer identifiers to database profile ${studentId}`);
    }
  } else {
    console.log(`[INFO] Reusing existing Customer ${customerProviderId} for user ${studentId} on provider ${providerName}`);

    // Dual write check: keep provider fields synced if empty
    if (!profile.provider_customer_id || profile.provider_name !== providerName) {
      await supabase
        .from('profiles')
        .update({ provider_customer_id: customerProviderId, provider_name: providerName })
        .eq('id', studentId);
    }
  }
  return customerProviderId as string;
}

/** Cria a cobranca; se o Asaas recusar o cliente, recria o cliente e tenta uma vez. */
export async function createPaymentWithCustomerRecovery(p: {
  paymentProvider: Any;
  supabase: Any;
  providerName: string;
  studentId: string;
  customerProviderId: string;
  userEmail: string;
  profile: { full_name?: string | null; phone: string; cpf: string };
  paymentDTO: Any;
}): Promise<Any> {
  try {
    return await p.paymentProvider.createPayment(p.paymentDTO);
  } catch (firstPaymentError: Any) {
    if (!isInvalidCustomerError(firstPaymentError)) {
      throw firstPaymentError;
    }

    const newCustomerProviderId = await recoverInvalidCustomer({
      paymentProvider: p.paymentProvider,
      supabase: p.supabase,
      providerName: p.providerName,
      secureStudentId: p.studentId,
      oldCustomerProviderId: p.customerProviderId,
      userEmail: p.userEmail || '',
      fullName: p.profile.full_name || p.userEmail || 'Aluno',
      phone: p.profile.phone,
      cpf: p.profile.cpf,
      originalError: firstPaymentError,
    });

    try {
      const paymentResponse = await p.paymentProvider.createPayment({ ...p.paymentDTO, customerProviderId: newCustomerProviderId });
      console.log(`[ASAAS CUSTOMER RECOVERY] Payment retry successful with new Customer ID:
- userId: ${p.studentId}
- newProviderCustomerId: ${newCustomerProviderId}
- providerPaymentId: ${paymentResponse.providerPaymentId}
- retryResult: SUCCESS`);
      return paymentResponse;
    } catch (retryError: Any) {
      console.error(`[ASAAS CUSTOMER RECOVERY] Payment retry failed:
- userId: ${p.studentId}
- newProviderCustomerId: ${newCustomerProviderId}
- retryResult: FAILED
- error: ${retryError.message}`);
      throw retryError;
    }
  }
}

/**
 * Cronograma oficial de parcelas (payment_installments) da cobranca criada.
 * Mesmo registro do fluxo atual (P-1.16A / P-1.18E).
 */
export async function recordBookingChargeSchedule(p: {
  supabase: Any;
  paymentProvider: Any;
  paymentResponse: Any;
  installmentCount: number | undefined | null;
  charge: BookingChargeQuote;
  groupId: string;
  appointmentId: string | null;
  studentId: string;
  instructorId: string;
}): Promise<void> {
  let providerPaymentIdMap: Map<number, string> | undefined = undefined;
  const installmentId = p.paymentResponse.providerInstallmentId;

  if (p.installmentCount && p.installmentCount > 1 && installmentId && typeof p.paymentProvider.getInstallmentPayments === 'function') {
    const installmentItems = await p.paymentProvider.getInstallmentPayments(installmentId, p.installmentCount);
    providerPaymentIdMap = new Map<number, string>();
    for (const item of installmentItems) {
      providerPaymentIdMap.set(item.installmentNumber, item.id);
    }
    console.log(`✅ [CREATE_BOOKING_INTENT] Obtained ${providerPaymentIdMap.size} individual payment IDs for installment collection '${installmentId}'`);
  }

  await InstallmentService.recordInitialSchedule(p.supabase, {
    providerPaymentId: p.paymentResponse.providerPaymentId,
    providerPaymentIdMap: providerPaymentIdMap,
    totalInstallments: p.installmentCount || 1,
    grossAmountCents: p.charge.totalPriceWithFee,
    netAmountCents: p.charge.instructorNetCents,
    // P-1.18E (decisao J1 da P-1.18A): platform_fee e' a COMISSAO PURA.
    // A tarifa do gateway pertence ao student_charge e ja' e' registrada
    // em feeAmountCents; soma-la aqui contabilizava a tarifa duas vezes e
    // inflava a receita da plataforma.
    //   gross  = net + platform_fee + fee_amount   (identidade exata)
    platformFeeCents: p.charge.applicationFeeAmount,
    feeAmountCents: p.charge.processingFee,
    // P-1.16A: congelamento da tarifa aplicada a esta compra.
    // Uma alteracao futura do schedule nao recalcula esta linha.
    feeRuleId: p.charge.appliedFee.feeRuleId,
    feePercentApplied: p.charge.appliedFee.feePercentApplied,
    feeFixedCents: p.charge.appliedFee.feeFixedCents,
    feeSource: p.charge.appliedFee.feeSource,
    feeEffectiveFrom: p.charge.appliedFee.feeEffectiveFrom,
    paymentMethod: p.charge.appliedFee.paymentMethod,
    groupId: p.groupId,
    appointmentId: p.appointmentId,
    studentId: p.studentId,
    instructorId: p.instructorId,
  });
}
