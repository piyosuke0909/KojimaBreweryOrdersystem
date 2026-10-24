import { computePricing, type PricingSettings, type TaxRounding, type TaxUnit } from '../../domain';
import { fail, type Row } from './common';

export interface OrderTaxPolicy extends PricingSettings {
  tax_rate: number;
  tax_calc_unit: TaxUnit;
  tax_rounding: TaxRounding;
  shipping_taxable: boolean;
  source: 'snapshot' | 'inferred' | 'neutral';
}

/** Resolve historical tax treatment only from its saved values, never current settings. */
export function resolveOrderTaxPolicy(order: Row, storedItems: Row[], candidateShippingFee = Number(order.shipping_fee)): OrderTaxPolicy {
  const base = { tax_rate: Number(order.snap_tax_rate), tax_calc_unit: order.snap_tax_calc_unit as TaxUnit, tax_rounding: order.snap_tax_rounding as TaxRounding };
  const fee = Number(order.shipping_fee), savedTax = Number(order.tax_amount);
  let nonTaxable: number, taxable: number;
  try {
    nonTaxable = computePricing(storedItems as { unit_price: number; quantity: number }[], { ...base, shipping_fee: fee, shipping_taxable: false }).tax_amount;
    taxable = computePricing(storedItems as { unit_price: number; quantity: number }[], { ...base, shipping_fee: fee, shipping_taxable: true }).tax_amount;
  } catch {
    return fail(409, 'TAX_POLICY_UNKNOWN', '注文時の税条件を確認できません。保存済みの注文金額を変更せず、管理者へお問い合わせください。');
  }
  if (order.snap_shipping_taxable === 0 || order.snap_shipping_taxable === 1) {
    const flag = order.snap_shipping_taxable === 1;
    if (savedTax !== (flag ? taxable : nonTaxable)) fail(409, 'TAX_POLICY_UNKNOWN', '保存済みの税額と税条件が一致しません。管理者へお問い合わせください。');
    return { ...base, shipping_taxable: flag, source: 'snapshot' };
  }
  const matchesFalse = savedTax === nonTaxable!, matchesTrue = savedTax === taxable!;
  if (matchesFalse !== matchesTrue) return { ...base, shipping_taxable: matchesTrue, source: 'inferred' };
  // A neutral old policy must remain NULL in storage. A later shipping charge
  // cannot inherit an arbitrarily chosen value from an earlier free delivery.
  if (matchesFalse && matchesTrue && (base.tax_rate === 0 || (fee === 0 && candidateShippingFee === 0))) return { ...base, shipping_taxable: false, source: 'neutral' };
  return fail(409, 'TAX_POLICY_UNKNOWN', 'この注文は過去の送料課税条件を確定できません。現在の税設定では再計算せず、管理者へお問い合わせください。');
}

/** Invoice-level rounding happens once per rate, using each order's saved tax basis. */
export function invoiceTaxFromOrders(orders: Row[], details: Row[]) {
  const policies = orders.map(order => ({ order_id: order.id, ...resolveOrderTaxPolicy(order, details.filter(item => item.order_id === order.id)) }));
  const groups = new Map<number, { policy: OrderTaxPolicy; lines: Row[]; taxableShipping: number }>();
  let tax = 0;
  for (const [index, order] of orders.entries()) {
    const policy = policies[index]!;
    if (policy.tax_calc_unit !== 'invoice') { tax += Number(order.tax_amount); continue; }
    const group = groups.get(policy.tax_rate);
    if (group && group.policy.tax_rounding !== policy.tax_rounding) fail(409, 'TAX_POLICY_MIXED_ROUNDING', '同じ税率で端数処理の異なる注文が含まれています。対象注文を分けて請求書を発行してください。');
    const current = group ?? { policy, lines: [], taxableShipping: 0 };
    current.lines.push(...details.filter(item => item.order_id === order.id));
    if (policy.shipping_taxable) current.taxableShipping += Number(order.shipping_fee);
    groups.set(policy.tax_rate, current);
  }
  for (const group of groups.values()) tax += computePricing(group.lines as { unit_price: number; quantity: number }[], { ...group.policy, tax_calc_unit: 'invoice', shipping_taxable: true, shipping_fee: group.taxableShipping }).tax_amount;
  if (!Number.isSafeInteger(tax) || tax < 0) fail(422, 'INVOICE_AMOUNT_TOO_LARGE', '請求金額が扱える範囲を超えています。対象注文を分けてください。');
  const uniform = (key: keyof OrderTaxPolicy) => policies.every(policy => policy[key] === policies[0]?.[key]) ? String(policies[0]?.[key]) : 'mixed';
  const taxSettings = { source: 'order_snapshots', tax_rate: uniform('tax_rate'), tax_calc_unit: uniform('tax_calc_unit'), tax_rounding: uniform('tax_rounding'), shipping_taxable: uniform('shipping_taxable') };
  return { tax, policies, taxSettings };
}
