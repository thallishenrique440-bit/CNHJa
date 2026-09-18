/**
 * P-1.16B — Aplicacao do plano de sincronizacao.
 *
 * Contrato de seguranca:
 *   - falha de LEITURA  -> nao aplica nada, tarifa vigente intacta;
 *   - falha ao FECHAR   -> pula a faixa, a versao anterior segue vigente;
 *   - falha ao INSERIR  -> REABRE a versao anterior (effective_to = null),
 *                          para nunca deixar o metodo sem tarifa vigente;
 *   - nunca apaga linha, nunca grava zero por ausencia de campo.
 *
 * Recebe o client por parametro (service role em producao, fake nos testes).
 */
import {
  GATEWAY_FEE_SELECT,
  GATEWAY_FEE_TABLE
} from './GatewayFeeModel.js';
import {
  CurrentFeeRow,
  GatewayFeeSyncPlan
} from './GatewayFeeSyncPlanner.js';

export interface ApplyResult {
  applied: Array<{ method: string; range: string; percent: number; fixedCents: number; replacedId: string | null }>;
  failed: Array<{ method: string; range: string; stage: 'close' | 'insert'; error: string; rolledBack: boolean }>;
}

export async function readCurrentFeeRows(
  supabase: any,
  provider: string
): Promise<{ rows: CurrentFeeRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from(GATEWAY_FEE_TABLE)
    .select(GATEWAY_FEE_SELECT)
    .eq('provider', provider)
    .is('effective_to', null);

  if (error) return { rows: [], error: error.message || String(error) };
  return { rows: (data || []) as CurrentFeeRow[], error: null };
}

export async function applyGatewayFeeSync(
  supabase: any,
  provider: string,
  plan: GatewayFeeSyncPlan,
  nowIso: string
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], failed: [] };

  for (const ins of plan.insert) {
    const range = ins.installmentFrom === ins.installmentTo
      ? `${ins.installmentFrom}x`
      : `${ins.installmentFrom}-${ins.installmentTo}x`;

    // 1. Fechar a versao vigente, se houver.
    if (ins.replacesId) {
      const { error: closeErr } = await supabase
        .from(GATEWAY_FEE_TABLE)
        .update({ effective_to: nowIso, updated_at: nowIso })
        .eq('id', ins.replacesId);

      if (closeErr) {
        console.error(`[SyncFees] Falha ao fechar a versao vigente de ${ins.method} ${range}. Faixa preservada como estava.`, closeErr.message || closeErr);
        result.failed.push({ method: ins.method, range, stage: 'close', error: closeErr.message || String(closeErr), rolledBack: false });
        continue;
      }
    }

    // 2. Inserir a nova versao.
    const { error: insErr } = await supabase
      .from(GATEWAY_FEE_TABLE)
      .insert({
        provider,
        method: ins.method,
        installment_from: ins.installmentFrom,
        installment_to: ins.installmentTo,
        percent: ins.percent,
        fixed_cents: ins.fixedCents,
        effective_from: nowIso,
        source: 'asaas',
        notes: 'Sincronizado de GET /v3/myAccount/fees'
      });

    if (insErr) {
      console.error(`[SyncFees] Falha ao inserir nova versao de ${ins.method} ${range}.`, insErr.message || insErr);
      let rolledBack = false;
      if (ins.replacesId) {
        const { error: reopenErr } = await supabase
          .from(GATEWAY_FEE_TABLE)
          .update({ effective_to: null, updated_at: nowIso })
          .eq('id', ins.replacesId);
        rolledBack = !reopenErr;
        if (reopenErr) {
          console.error(`[SyncFees] CRITICO: nao foi possivel reabrir a versao ${ins.replacesId} de ${ins.method} ${range}. Faixa pode estar sem tarifa vigente.`, reopenErr.message || reopenErr);
        }
      }
      result.failed.push({ method: ins.method, range, stage: 'insert', error: insErr.message || String(insErr), rolledBack });
      continue;
    }

    result.applied.push({ method: ins.method, range, percent: ins.percent, fixedCents: ins.fixedCents, replacedId: ins.replacesId });
  }

  return result;
}

/**
 * Idade da sincronizacao mais recente, em dias. null = nunca sincronizado.
 * Derivado das linhas ja lidas: nenhuma tabela adicional.
 */
export function syncAgeDays(rows: Array<{ source?: string; effective_from?: string }>, nowIso: string): number | null {
  const stamps = (rows || [])
    .filter(r => String(r.source || '') === 'asaas' && r.effective_from)
    .map(r => new Date(String(r.effective_from)).getTime())
    .filter(t => Number.isFinite(t));
  if (stamps.length === 0) return null;
  const newest = Math.max(...stamps);
  const now = new Date(nowIso).getTime();
  return Math.floor((now - newest) / 86400000);
}
