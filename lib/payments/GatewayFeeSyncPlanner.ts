/**
 * P-1.16B — Planejamento puro da sincronizacao de tarifas.
 *
 * Decide, sem tocar no banco, o que fazer com cada faixa extraida do Asaas:
 *   - identica a vigente  -> nada (idempotencia);
 *   - diferente           -> fechar a vigente + inserir nova versao;
 *   - inexistente         -> inserir primeira versao.
 *
 * Nunca produz plano que apague historico ou zere tarifa.
 * Sem imports: modulo puro e testavel.
 */

export interface CurrentFeeRow {
  id: string;
  provider: string;
  method: string;
  installment_from: number;
  installment_to: number;
  percent: number | string;
  fixed_cents: number;
  source?: string;
}

export interface DesiredFeeRange {
  method: string;
  installmentFrom: number;
  installmentTo: number;
  percent: number;
  fixedCents: number;
}

export interface SyncPlanClose { id: string; method: string; range: string; }
export interface SyncPlanInsert {
  method: string;
  installmentFrom: number;
  installmentTo: number;
  percent: number;
  fixedCents: number;
  /** id da versao que sera fechada; null quando e' a primeira versao. */
  replacesId: string | null;
}
export interface SyncPlanUnchanged { method: string; range: string; percent: number; fixedCents: number; }

export interface GatewayFeeSyncPlan {
  close: SyncPlanClose[];
  insert: SyncPlanInsert[];
  unchanged: SyncPlanUnchanged[];
}

const rangeLabel = (from: number, to: number) => (from === to ? `${from}x` : `${from}-${to}x`);

/** Comparacao numerica tolerante a numeric vindo do Postgres como string. */
function sameNumber(a: number | string, b: number | string): boolean {
  return Number(a) === Number(b);
}

export function planGatewayFeeSync(
  current: CurrentFeeRow[],
  desired: DesiredFeeRange[]
): GatewayFeeSyncPlan {
  const plan: GatewayFeeSyncPlan = { close: [], insert: [], unchanged: [] };

  for (const want of desired) {
    const method = String(want.method).toUpperCase();
    const existing = (current || []).find(r =>
      String(r.method).toUpperCase() === method &&
      Number(r.installment_from) === want.installmentFrom &&
      Number(r.installment_to) === want.installmentTo
    );

    const label = rangeLabel(want.installmentFrom, want.installmentTo);

    if (existing &&
        sameNumber(existing.percent, want.percent) &&
        sameNumber(existing.fixed_cents, want.fixedCents)) {
      plan.unchanged.push({ method, range: label, percent: want.percent, fixedCents: want.fixedCents });
      continue;
    }

    if (existing) {
      plan.close.push({ id: existing.id, method, range: label });
    }

    plan.insert.push({
      method,
      installmentFrom: want.installmentFrom,
      installmentTo: want.installmentTo,
      percent: want.percent,
      fixedCents: want.fixedCents,
      replacesId: existing ? existing.id : null
    });
  }

  return plan;
}

/**
 * Faixas vigentes que a sincronizacao NAO tocou. Ficam sob gestao manual.
 * Serve para provar, no relatorio do job, que nada foi sobrescrito as cegas.
 */
export function untouchedRanges(current: CurrentFeeRow[], desired: DesiredFeeRange[]): SyncPlanUnchanged[] {
  return (current || [])
    .filter(r => !(desired || []).some(w =>
      String(w.method).toUpperCase() === String(r.method).toUpperCase() &&
      w.installmentFrom === Number(r.installment_from) &&
      w.installmentTo === Number(r.installment_to)
    ))
    .map(r => ({
      method: String(r.method).toUpperCase(),
      range: rangeLabel(Number(r.installment_from), Number(r.installment_to)),
      percent: Number(r.percent),
      fixedCents: Number(r.fixed_cents)
    }));
}
