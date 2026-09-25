/**
 * P-1.16B — Sincronizacao das tarifas oficiais do Asaas.
 *
 * Fluxo: GET /v3/myAccount/fees -> parseAsaasFees (so' o que for inequivoco)
 *        -> planGatewayFeeSync (idempotente) -> applyGatewayFeeSync (versiona).
 *
 * Garantias:
 *   - NUNCA escreve em appointments, appointments.price ou precos de instrutor;
 *   - NUNCA recalcula compras antigas nem toca em snapshots congelados;
 *   - NUNCA zera uma tarifa por ausencia de campo na resposta;
 *   - falha de rede ou de banco preserva a ultima tarifa valida;
 *   - idempotente: tarifa igual nao gera versao nova.
 *
 * Autenticacao: Bearer CRON_SECRET. Nenhum segredo vive neste arquivo.
 */
import { createClient } from '@supabase/supabase-js';
import { parseAsaasFees } from '../lib/payments/AsaasFeeParser.js';
import { planGatewayFeeSync, untouchedRanges } from '../lib/payments/GatewayFeeSyncPlanner.js';
import { applyGatewayFeeSync, readCurrentFeeRows, syncAgeDays } from '../lib/payments/GatewayFeeSyncService.js';
import { resolveAsaasEnvironment } from '../lib/payments/AsaasEnvironment.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PROVIDER = 'asaas';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.error('[SyncFees] Unauthorized attempt: invalid or missing CRON_SECRET.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowIso = new Date().toISOString();

  try {
    const asaasApiKey = process.env.ASAAS_API_KEY;
    if (!asaasApiKey) {
      console.error('[SyncFees] ASAAS_API_KEY nao definida. Tarifa vigente preservada.');
      return res.status(500).json({ error: 'ASAAS_API_KEY is not defined in the server.', ratesPreserved: true });
    }

    // AP-04: ambiente explicito e coerente; sem fallback para sandbox.
    let asaasApiUrl: string;
    try {
      asaasApiUrl = resolveAsaasEnvironment((name) => process.env[name], { requireApiKey: true }).apiUrl;
    } catch (envErr: any) {
      console.error(`[SyncFees] Ambiente Asaas invalido. Tarifa vigente preservada. ${envErr?.message ?? envErr}`);
      return res.status(500).json({ error: 'Asaas environment misconfigured.', ratesPreserved: true });
    }

    // ---- 1. Consulta ao Asaas ---------------------------------------------
    let asaasData: any;
    try {
      const asaasResponse = await fetch(`${asaasApiUrl}/myAccount/fees`, {
        method: 'GET',
        headers: { 'access_token': asaasApiKey }
      });

      if (!asaasResponse.ok) {
        const errorText = await asaasResponse.text();
        console.error(`[SyncFees] Asaas respondeu HTTP ${asaasResponse.status}. Tarifa vigente preservada. Detalhe: ${errorText}`);
        return res.status(502).json({
          error: 'Failed to retrieve fees from Asaas gateway.',
          status: asaasResponse.status,
          ratesPreserved: true
        });
      }

      asaasData = await asaasResponse.json();
    } catch (netErr: any) {
      console.error('[SyncFees] Falha de rede ao consultar o Asaas. Tarifa vigente preservada.', netErr?.message || netErr);
      return res.status(502).json({
        error: 'Network failure contacting Asaas.',
        detail: netErr?.message || String(netErr),
        ratesPreserved: true
      });
    }

    // ---- 2. Extracao (so' o inequivoco) -----------------------------------
    const parsed = parseAsaasFees(asaasData);
    console.log(`[SyncFees] Faixas extraidas: ${parsed.ranges.length}. Faixas mantidas manuais: ${parsed.unmapped.length}.`);
    for (const u of parsed.unmapped) {
      console.log(`[SyncFees] MANUAL ${u.method} ${u.installmentFrom}-${u.installmentTo}x: ${u.reason}`);
    }

    // ---- 3. Leitura do estado vigente -------------------------------------
    const { rows: currentRows, error: readErr } = await readCurrentFeeRows(supabaseAdmin, PROVIDER);
    if (readErr) {
      console.error('[SyncFees] Falha ao ler gateway_fee_schedule. Nada foi alterado.', readErr);
      return res.status(500).json({
        error: 'Database error reading gateway fee schedule. Existing rates preserved.',
        ratesPreserved: true
      });
    }

    const ageBefore = syncAgeDays(currentRows as any, nowIso);

    if (parsed.ranges.length === 0) {
      console.warn('[SyncFees] Nenhuma faixa pode ser extraida com seguranca. Tarifa vigente preservada integralmente.');
      return res.status(200).json({
        success: true,
        syncedAt: nowIso,
        updated: false,
        applied: [],
        unchanged: [],
        manual: parsed.unmapped,
        ratesPreserved: true,
        lastSyncAgeDays: ageBefore,
        note: 'Nenhum campo pode ser mapeado com seguranca; nada foi sobrescrito.'
      });
    }

    // ---- 4. Plano e aplicacao ---------------------------------------------
    const plan = planGatewayFeeSync(currentRows, parsed.ranges.map(r => ({
      method: r.method,
      installmentFrom: r.installmentFrom,
      installmentTo: r.installmentTo,
      percent: r.percent,
      fixedCents: r.fixedCents
    })));

    const untouched = untouchedRanges(currentRows, parsed.ranges.map(r => ({
      method: r.method, installmentFrom: r.installmentFrom, installmentTo: r.installmentTo,
      percent: r.percent, fixedCents: r.fixedCents
    })));

    const applyRes = await applyGatewayFeeSync(supabaseAdmin, PROVIDER, plan, nowIso);

    console.log(`[SyncFees] Concluido. Atualizadas: ${applyRes.applied.length}, sem mudanca: ${plan.unchanged.length}, falhas: ${applyRes.failed.length}, intocadas: ${untouched.length}.`);

    return res.status(200).json({
      success: applyRes.failed.length === 0,
      syncedAt: nowIso,
      updated: applyRes.applied.length > 0,
      applied: applyRes.applied,
      unchanged: plan.unchanged,
      failed: applyRes.failed,
      untouched,
      manual: parsed.unmapped,
      evidence: parsed.ranges.map(r => ({
        method: r.method,
        range: `${r.installmentFrom}-${r.installmentTo}x`,
        percentFrom: r.evidence.percent,
        fixedFrom: r.evidence.fixed
      })),
      lastSyncAgeDaysBefore: ageBefore,
      note: 'Esta rotina nao altera appointments.price, precos de instrutor, compras existentes nem snapshots congelados.'
    });

  } catch (error: any) {
    console.error('[SyncFees] Excecao nao tratada. Tarifa vigente preservada.', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error', ratesPreserved: true });
  }
}
