/**
 * P-1.16A — Leitura do schedule de tarifas.
 *
 * Aceita qualquer client supabase-js (service role no backend, client do
 * browser no frontend). Nunca escreve. Nunca lanca: em caso de erro devolve
 * lista vazia, e quem chama cai no DEFAULT_GATEWAY_FEE_SCHEDULE de
 * GatewayFeeModel — a tarifa jamais e' zerada por falha de leitura.
 */
import {
  DEFAULT_FEE_PROVIDER,
  GATEWAY_FEE_SELECT,
  GATEWAY_FEE_TABLE,
  GatewayFeeRule,
  mapGatewayFeeRows
} from './GatewayFeeModel.js';

export async function fetchGatewayFeeRules(
  supabase: any,
  provider: string = DEFAULT_FEE_PROVIDER
): Promise<GatewayFeeRule[]> {
  try {
    const { data, error } = await supabase
      .from(GATEWAY_FEE_TABLE)
      .select(GATEWAY_FEE_SELECT)
      .eq('provider', provider)
      .is('effective_to', null);

    if (error) {
      console.error('[GatewayFeeRepository] Failed to read gateway_fee_schedule:', error.message || error);
      return [];
    }

    return mapGatewayFeeRows(data);
  } catch (err: any) {
    console.error('[GatewayFeeRepository] Exception reading gateway_fee_schedule:', err?.message || err);
    return [];
  }
}
