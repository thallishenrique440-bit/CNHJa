/**
 * P-1.18P2.6 — Reconciliacao de pagamento pelo fluxo financeiro OFICIAL.
 *
 * PROBLEMA QUE ESTE ENDPOINT RESOLVE
 * ----------------------------------
 * Quando o webhook do Asaas nao chega (ou nao e' processado), a compra fica sem
 * liquidacao. Ate' a P-1.18P2.5 a unica rotina de recuperacao era a Edge
 * Function sync-payment-status, que possuia uma SEGUNDA implementacao da regra
 * financeira — com aritmetica invertida, tarifa zerada e status 'PAID'.
 *
 * Aqui a recuperacao passa a usar o MESMO caminho do webhook:
 *
 *   sync-payment-status (Edge/Deno)
 *     -> POST /api/reconcile-payment  (Bearer CRON_SECRET, so' o identificador)
 *        -> GET /payments/{id} no Asaas          (origem unica do valor)
 *        -> SettlementService.processSettlement  (AUTORIDADE FINANCEIRA)
 *        -> InstallmentService.recordPaymentSettlement (parcela RECEIVED)
 *
 * NAO HA' CALCULO FINANCEIRO NESTE ARQUIVO.
 *   - a tarifa real e' derivada de value - netValue, identica a
 *     api/asaas-webhook.ts:695-702;
 *   - gross_amount, net_amount e platform_fee sao LIDOS de payment_installments
 *     (o contrato congelado na criacao da compra), identico a
 *     api/asaas-webhook.ts:653-655;
 *   - a comissao da CNHJa e o valor do instrutor NAO sao recalculados aqui.
 *
 * SEGURANCA
 *   - Bearer CRON_SECRET, mesmo padrao de api/sync-fees.ts e api/worker.ts;
 *   - o corpo aceita EXCLUSIVAMENTE { providerPaymentId }. Qualquer outra chave
 *     e' recusada — o chamador nao escolhe nenhum valor financeiro;
 *   - nenhum segredo e' registrado em log.
 *
 * ESTADOS
 *   - liquida somente RECEIVED e RECEIVED_IN_CASH;
 *   - CONFIRMED significa cartao autorizado com credito AINDA FUTURO e NAO
 *     liquida, replicando api/asaas-webhook.ts:691.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AsaasProvider } from '../lib/payments/AsaasProvider.js';
import { SettlementService } from '../lib/payments/SettlementService.js';
import { SettlementOutcome } from '../lib/payments/SettlementTypes.js';
import { InstallmentService } from '../lib/payments/InstallmentService.js';

/** Estados do Asaas em que o dinheiro FOI efetivamente recebido. */
export const SETTLEABLE_ASAAS_STATUSES = ['RECEIVED', 'RECEIVED_IN_CASH'];

/** Unica chave aceita no corpo. */
export const ALLOWED_BODY_KEYS = ['providerPaymentId'];

export interface ReconcileValidation {
  ok: boolean;
  providerPaymentId?: string;
  httpStatus?: number;
  error?: string;
  code?: string;
}

/**
 * Valida o corpo da requisicao.
 *
 * Recusa QUALQUER chave alem de providerPaymentId. Isso cobre, por construcao,
 * value / netValue / feeAmount / platformFee / instructorAmount / grossAmount /
 * netAmount e as variantes snake_case: o chamador nao tem como influenciar
 * nenhum valor financeiro.
 */
export function validateReconcileBody(body: unknown): ReconcileValidation {
  let parsed: any = body;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ok: false, httpStatus: 400, error: 'Corpo invalido: JSON malformado.', code: 'INVALID_JSON' };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, httpStatus: 400, error: 'Corpo invalido: esperado objeto JSON.', code: 'INVALID_BODY' };
  }

  const keys = Object.keys(parsed);
  const extras = keys.filter(k => !ALLOWED_BODY_KEYS.includes(k));
  if (extras.length > 0) {
    return {
      ok: false,
      httpStatus: 400,
      error: `Campos nao permitidos no corpo: ${extras.join(', ')}. Este endpoint aceita apenas providerPaymentId; todo valor financeiro vem do Asaas e do contrato ja' gravado.`,
      code: 'FORBIDDEN_FIELDS'
    };
  }

  const providerPaymentId = parsed.providerPaymentId;
  if (typeof providerPaymentId !== 'string' || providerPaymentId.trim() === '') {
    return { ok: false, httpStatus: 400, error: 'providerPaymentId ausente ou invalido.', code: 'MISSING_PROVIDER_PAYMENT_ID' };
  }

  return { ok: true, providerPaymentId: providerPaymentId.trim() };
}

/**
 * Tarifa REAL do Asaas, em centavos.
 * Formula identica a api/asaas-webhook.ts:695-702. Nao ha' formula nova.
 */
export function deriveAsaasFeeCents(raw: any): number | undefined {
  if (raw?.value !== undefined && raw?.netValue !== undefined) {
    return Math.max(0, Math.round(Number(raw.value) * 100) - Math.round(Number(raw.netValue) * 100));
  }
  if (raw?.feeValue !== undefined) {
    return Math.round(Number(raw.feeValue) * 100);
  }
  return undefined;
}

export function isSettleableStatus(status: unknown): boolean {
  return SETTLEABLE_ASAAS_STATUSES.includes(String(status || '').toUpperCase());
}

export interface ReconcileDeps {
  supabase: SupabaseClient;
  getPaymentRaw: (providerPaymentId: string) => Promise<any>;
  processSettlement: typeof SettlementService.processSettlement;
  recordPaymentSettlement: typeof InstallmentService.recordPaymentSettlement;
}

export interface ReconcileResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/**
 * Nucleo da reconciliacao. Separado do handler HTTP para ser testavel sem rede.
 */
export async function reconcilePayment(
  deps: ReconcileDeps,
  providerPaymentId: string
): Promise<ReconcileResult> {
  const raw = await deps.getPaymentRaw(providerPaymentId);

  const asaasStatus = String(raw?.status || '').toUpperCase();

  // CONFIRMED (e qualquer outro estado) NAO liquida: o credito ainda e' futuro.
  if (!isSettleableStatus(asaasStatus)) {
    return {
      httpStatus: 200,
      body: {
        outcome: 'NOT_SETTLEABLE',
        settled: false,
        providerPaymentId,
        asaasStatus,
        reason: 'Liquidacao ocorre apenas em RECEIVED ou RECEIVED_IN_CASH.'
      }
    };
  }

  const installmentNumber = Number(raw?.installmentNumber) > 0 ? Number(raw.installmentNumber) : 1;
  const totalInstallments = Number(raw?.installmentCount) > 0 ? Number(raw.installmentCount) : 1;
  const paymentDate = raw?.paymentDate || raw?.clientPaymentDate || new Date().toISOString();

  // Contrato financeiro oficial da parcela, congelado na criacao da compra.
  // Mesma leitura de api/asaas-webhook.ts:653-655. Nada e' recalculado.
  const { data: installment, error: instError } = await deps.supabase
    .from('payment_installments')
    .select('id, gross_amount, net_amount, platform_fee, fee_amount, group_id, appointment_id, student_id, instructor_id, status')
    .eq('provider_payment_id', providerPaymentId)
    .eq('installment_number', installmentNumber)
    .maybeSingle();

  if (instError) {
    return {
      httpStatus: 500,
      body: { outcome: 'ERROR', settled: false, providerPaymentId, error: 'Falha ao ler payment_installments.' }
    };
  }

  if (!installment) {
    return {
      httpStatus: 409,
      body: {
        outcome: 'INSTALLMENT_NOT_FOUND',
        settled: false,
        providerPaymentId,
        installmentNumber,
        reason: 'Contrato oficial ausente em payment_installments. Sem ele nao ha' + ' como liquidar sem inventar valores.'
      }
    };
  }

  const feeAmount = deriveAsaasFeeCents(raw);

  const settleRes = await deps.processSettlement(
    {
      origin: 'LESSON',
      providerPaymentId,
      installmentNumber,
      providerSettlementId: raw?.id || providerPaymentId,
      settlementType: 'PAYMENT' as any,
      grossAmount: installment.gross_amount,
      netAmount: installment.net_amount,
      platformFee: installment.platform_fee,
      feeAmount,
      settledAt: paymentDate,
      appointmentId: installment.appointment_id || null,
      studentId: installment.student_id || null,
      instructorId: installment.instructor_id || null
    },
    deps.supabase
  );

  if (settleRes.outcome === SettlementOutcome.ERROR) {
    return {
      httpStatus: 500,
      body: {
        outcome: settleRes.outcome,
        settled: false,
        providerPaymentId,
        installmentNumber,
        warnings: settleRes.warnings
      }
    };
  }

  // A parcela so' e' marcada DEPOIS de a liquidacao oficial existir.
  // SettlementService nunca toca payment_installments (invariante declarada no
  // seu cabecalho), entao este passo espelha exatamente o que o webhook faz em
  // api/asaas-webhook.ts:990. Nunca grava 'PAID'.
  await deps.recordPaymentSettlement(deps.supabase, {
    providerPaymentId,
    installmentNumber,
    totalInstallments,
    grossAmountCents: installment.gross_amount,
    netAmountCents: installment.net_amount,
    platformFeeCents: installment.platform_fee,
    feeAmountCents: installment.fee_amount || 0,
    paymentDate,
    groupId: installment.group_id || null,
    appointmentId: installment.appointment_id || null,
    studentId: installment.student_id || null,
    instructorId: installment.instructor_id || null,
    providerSettlementId: raw?.id || providerPaymentId
  });

  return {
    httpStatus: 200,
    body: {
      outcome: settleRes.outcome,
      settled: true,
      providerPaymentId,
      installmentNumber,
      totalInstallments,
      groupId: installment.group_id || null,
      asaasStatus
    }
  };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const authHeader = req.headers?.authorization;
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.error('[ReconcilePayment] Tentativa nao autorizada: CRON_SECRET ausente ou invalido.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const validation = validateReconcileBody(req.body);
  if (!validation.ok) {
    console.warn(`[ReconcilePayment] Corpo recusado: ${validation.code}`);
    return res.status(validation.httpStatus || 400).json({ error: validation.error, code: validation.code });
  }

  const providerPaymentId = validation.providerPaymentId!;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const provider = new AsaasProvider();

    const result = await reconcilePayment(
      {
        supabase,
        getPaymentRaw: async (id: string) => {
          const dto = await provider.getPayment(id);
          return dto.rawResponse;
        },
        processSettlement: SettlementService.processSettlement.bind(SettlementService),
        recordPaymentSettlement: InstallmentService.recordPaymentSettlement.bind(InstallmentService)
      },
      providerPaymentId
    );

    console.log(`[ReconcilePayment] ${providerPaymentId} -> ${result.body.outcome} (settled=${result.body.settled})`);
    return res.status(result.httpStatus).json(result.body);
  } catch (err: any) {
    console.error(`[ReconcilePayment] Falha ao reconciliar ${providerPaymentId}:`, err?.message || err);
    return res.status(500).json({ error: 'Falha na reconciliacao.', code: 'RECONCILE_FAILED' });
  }
}
