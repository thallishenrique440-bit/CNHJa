export type RefundOperationItem = { id: string; amountCents: number };
export type RefundOperationSplit = { id: string; amountCents: number };
export type RefundOperationKeyInput = {
  provider: string; providerPaymentId: string; providerInstallmentId?: string | null;
  refundScope: string; items: RefundOperationItem[]; splits?: RefundOperationSplit[];
  requestedAmountCents: number; allocationVersion: string;
};
const normalize = (value: string) => value.trim().normalize('NFC');
const cents = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Refund amounts must be non-negative integer cents'); return value; };
export function buildRefundOperationKey(input: RefundOperationKeyInput): string {
  const items = input.items.map((x) => ({ id: normalize(x.id), amountCents: cents(x.amountCents) })).sort((a,b) => a.id.localeCompare(b.id) || a.amountCents-b.amountCents);
  const splits = (input.splits || []).map((x) => ({ id: normalize(x.id), amountCents: cents(x.amountCents) })).sort((a,b) => a.id.localeCompare(b.id) || a.amountCents-b.amountCents);
  const canonical = { provider: normalize(input.provider).toLowerCase(), providerPaymentId: normalize(input.providerPaymentId), providerInstallmentId: input.providerInstallmentId ? normalize(input.providerInstallmentId) : null, refundScope: normalize(input.refundScope), items, splits, requestedAmountCents: cents(input.requestedAmountCents), allocationVersion: normalize(input.allocationVersion) };
  return `refund:v1:${JSON.stringify(canonical)}`;
}

/**
 * Chave ESTAVEL da obrigacao de estorno (v2).
 *
 * A v1 (`buildRefundOperationKey`) incluia os splits. O estado dos splits MUDA
 * no gateway (o Asaas marca o split como REFUNDED/CANCELED ao reverte-lo), a
 * lista filtrada mudava, a chave mudava junto e um novo ciclo do cron criava
 * OUTRA operacao para a MESMA obrigacao — com novo POST de estorno.
 *
 * A identidade de uma obrigacao e': provedor + pagamento (+ carne) + escopo +
 * aulas e seus valores + total pedido. Splits sao um DETALHE DE EXECUCAO: ficam
 * registrados na operacao (metadata.split_snapshot), nunca na identidade.
 * `input.splits` e' deliberadamente ignorado.
 */
export function buildRefundObligationKey(input: RefundOperationKeyInput): string {
  const items = input.items.map((x) => ({ id: normalize(x.id), amountCents: cents(x.amountCents) })).sort((a,b) => a.id.localeCompare(b.id) || a.amountCents-b.amountCents);
  const canonical = { provider: normalize(input.provider).toLowerCase(), providerPaymentId: normalize(input.providerPaymentId), providerInstallmentId: input.providerInstallmentId ? normalize(input.providerInstallmentId) : null, refundScope: normalize(input.refundScope), items, requestedAmountCents: cents(input.requestedAmountCents) };
  return `refund:v2:${JSON.stringify(canonical)}`;
}
