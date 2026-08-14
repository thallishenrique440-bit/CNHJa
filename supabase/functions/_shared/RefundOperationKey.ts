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
