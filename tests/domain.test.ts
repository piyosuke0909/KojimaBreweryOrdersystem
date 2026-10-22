import { describe, expect, it } from 'vitest';
import { addBusinessDays, calculatePackages, cancellationDeadline, canEditOrder, computePricing, determineYamatoSize, getDeliveryDates, getShippingFeatures, isBusinessDay, jstDate, type CalendarDay, type PackagingBox, type PackingItem, type YamatoRate, type YamatoSize } from '../src/domain';

const sizes: YamatoSize[] = [
  { size_code: '60', max_three_sides_cm: 60, max_weight_kg: 2 },
  { size_code: '80', max_three_sides_cm: 80, max_weight_kg: 5 },
  { size_code: '100', max_three_sides_cm: 100, max_weight_kg: 10 },
  { size_code: '120', max_three_sides_cm: 120, max_weight_kg: 15 },
  { size_code: '140', max_three_sides_cm: 140, max_weight_kg: 20 },
  { size_code: '160', max_three_sides_cm: 160, max_weight_kg: 25 },
];
const rates: YamatoRate[] = sizes.map((s) => ({ dest_region: '東京都', size_code: s.size_code, shipping_fee: Number(s.size_code) * 10, rate_type: 'standard' }));
const box = (id: string, capacity: number, volumes = [300, 500, 700]): PackagingBox => ({ id, name: id, supported_volumes_json: JSON.stringify(volumes), max_bottles: capacity, length_cm: 30, width_cm: 20, height_cm: 30, box_weight_kg: .5, allow_mixed: 1, priority: 100 - capacity });
const item = (product_id: string, volume_ml: number, quantity: number, weight_kg = 1): PackingItem => ({ product_id, volume_ml, quantity, weight_kg });
const settings = { dest_region: '東京都', date: '2026-10-19' };
const calendar: CalendarDay[] = [];
for (let date = new Date('2026-09-01T00:00:00Z'); date <= new Date('2026-11-30T00:00:00Z'); date = new Date(date.getTime() + 86_400_000)) {
  calendar.push({ date: date.toISOString().slice(0, 10), is_deliverable: ![0, 6].includes(date.getUTCDay()) });
}

describe('integer-yen pricing and invoice reference tax', () => {
  it('applies company unit prices exactly without quantity discounts', () => {
    expect(computePricing([{ unit_price: 2100, quantity: 6 }], { shipping_fee: 1000 })).toEqual({ items_subtotal: 12600, shipping_fee: 1000, tax_amount: 1360, total_amount: 14960, is_reference_tax: true });
  });
  it('distinguishes invoice/order rounding from per-item rounding', () => {
    const lines = [{ unit_price: 5, quantity: 1 }, { unit_price: 5, quantity: 1 }];
    expect(computePricing(lines, { tax_calc_unit: 'order' }).tax_amount).toBe(1);
    expect(computePricing(lines, { tax_calc_unit: 'item' }).tax_amount).toBe(0);
    expect(computePricing(lines, { tax_calc_unit: 'item', tax_rounding: 'ceil' }).tax_amount).toBe(2);
    expect(computePricing(lines, { tax_calc_unit: 'item', tax_rounding: 'round' }).tax_amount).toBe(2);
    expect(computePricing(lines, { tax_calc_unit: 'order' }).is_reference_tax).toBe(false);
  });
  it('honors a non-taxable shipping setting stored as a string', () => {
    expect(computePricing([{ unit_price: 100, quantity: 1 }], { shipping_fee: 1000, shipping_taxable: 'false' }).tax_amount).toBe(10);
  });
  it('rejects negative, fractional, NaN and unsafe money or quantities', () => {
    for (const value of [-1, .5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => computePricing([{ unit_price: value, quantity: 1 }])).toThrow();
      expect(() => computePricing([{ unit_price: 100, quantity: value }])).toThrow();
    }
    expect(() => computePricing([{ unit_price: 100, quantity: 0 }])).toThrow();
    expect(() => computePricing([{ unit_price: Number.MAX_SAFE_INTEGER, quantity: 2 }])).toThrow();
    expect(() => computePricing([], { shipping_fee: -1 })).toThrow();
  });
  it('handles zero tax, zero prices, and a fractional configured tax rate', () => {
    expect(computePricing([{ unit_price: 0, quantity: 1 }], { tax_rate: 0 }).total_amount).toBe(0);
    expect(computePricing([{ unit_price: 10000, quantity: 1 }], { tax_rate: '8.1' }).tax_amount).toBe(810);
  });
});

describe('holiday exceptions and JST deadlines', () => {
  it('uses JST at a UTC date boundary', () => {
    expect(jstDate('2026-10-18T15:00:00Z')).toBe('2026-10-19');
    expect(jstDate('2026-10-18T14:59:59Z')).toBe('2026-10-18');
  });
  it('counts operating days rather than calendar days in either direction', () => {
    expect(addBusinessDays('2026-10-16', 4, calendar)).toBe('2026-10-22');
    expect(addBusinessDays('2026-10-02', -3, calendar)).toBe('2026-09-29');
    expect(addBusinessDays('2026-10-19', 0, calendar)).toBe('2026-10-19');
    expect(isBusinessDay('2026-10-17', calendar)).toBe(false);
    expect(isBusinessDay('2026-12-01', calendar)).toBe(true);
  });
  it('honors event closures and keeps unconfigured future dates open', () => {
    const closed = calendar.map((row) => row.date === '2026-10-20' ? { ...row, is_deliverable: 0 } : row);
    expect(addBusinessDays('2026-10-19', 4, closed)).toBe('2026-10-26');
    expect(addBusinessDays('2026-11-30', 1, calendar)).toBe('2026-12-01');
    expect(() => isBusinessDay('2026-02-30', calendar)).toThrow();
  });
  it('opens weekends by default and offers a bounded booking window with an empty calendar', () => {
    expect(isBusinessDay('2026-10-17', [])).toBe(true);
    expect(addBusinessDays('2026-10-16', 1, [])).toBe('2026-10-17');
    const dates = getDeliveryDates('2026-10-16T01:00:00Z', {}, [], { min_lead_business_days: 1 });
    expect(dates).toHaveLength(90);
    expect(dates[0]).toBe('2026-10-17');
    expect(dates.at(-1)).toBe('2027-01-14');
  });
  it('skips only explicit holidays for both booking lead time and cancellation cutoff', () => {
    const holidays = [{ date: '2026-10-17', is_deliverable: 0 }];
    expect(getDeliveryDates('2026-10-16T01:00:00Z', {}, holidays, { min_lead_business_days: 1 })[0]).toBe('2026-10-18');
    expect(cancellationDeadline('2026-10-20', holidays)).toBe('2026-10-16T17:00:00+09:00');
    const order = { status: 'received', is_invoice_locked: 0, desired_delivery_date: '2026-10-20' };
    expect(canEditOrder(order, '2026-10-16T08:00:00Z', holidays)).toBe(true);
    expect(canEditOrder(order, '2026-10-16T08:00:00.001Z', holidays)).toBe(false);
    expect(addBusinessDays('2026-10-16', 2, [...holidays, { date: '2026-10-19', is_deliverable: 0 }])).toBe('2026-10-20');
    expect(() => addBusinessDays('2026-10-16', Number.MAX_SAFE_INTEGER, [])).toThrow();
  });
  it('intersects lead time, the shipping rule and deliverable dates', () => {
    const rule = { allowed_periods_json: '[{"start_day":1,"end_day":7},{"start_day":15,"end_day":22}]' };
    const dates = getDeliveryDates('2026-10-15T01:00:00Z', rule, calendar);
    expect(dates[0]).toBe('2026-10-21');
    expect(dates).toContain('2026-10-22');
    expect(dates).not.toContain('2026-10-23');
    expect(dates).not.toContain('2026-11-07');
    expect(getDeliveryDates('2026-10-15T01:00:00Z', { ...rule, status: 'inactive' }, calendar)).toEqual([]);
  });
  it('allows changes through exactly 17:00 JST three operating days before arrival', () => {
    const order = { status: 'received', is_invoice_locked: 0, desired_delivery_date: '2026-10-02' };
    expect(cancellationDeadline(order.desired_delivery_date, calendar)).toBe('2026-09-29T17:00:00+09:00');
    expect(canEditOrder(order, '2026-09-29T08:00:00.000Z', calendar)).toBe(true);
    expect(canEditOrder(order, '2026-09-29T08:00:00.001Z', calendar)).toBe(false);
    for (const status of ['confirmed', 'preparing']) expect(canEditOrder({ ...order, status }, '2026-09-28T08:00:00Z', calendar)).toBe(true);
    for (const status of ['shipped', 'completed', 'cancelled']) expect(canEditOrder({ ...order, status }, '2026-09-28T08:00:00Z', calendar)).toBe(false);
    expect(canEditOrder({ ...order, is_invoice_locked: 1 }, '2026-09-28T08:00:00Z', calendar)).toBe(false);
  });
});

describe('packaging, parcel size and shipping fares', () => {
  it('turns off dependent calculations without requiring disabled masters', () => {
    expect(getShippingFeatures()).toEqual({ packing_enabled: true, yamato_sizes_enabled: true, yamato_rates_enabled: true });
    expect(getShippingFeatures({ packing_enabled: 'false' })).toEqual({ packing_enabled: false, yamato_sizes_enabled: false, yamato_rates_enabled: false });
    const products = [item('a', 300, 8)];
    expect(calculatePackages(products, [], [], [], { ...settings, packing_enabled: false })).toEqual({ packages: [], shipping_fee: 0, discount_amount: 0 });
    const withoutSize = calculatePackages(products, [box('six', 6)], [], [], { ...settings, yamato_sizes_enabled: false });
    expect(withoutSize.packages).toHaveLength(2);
    expect(withoutSize.packages.every(p => p.size_code === null && p.shipping_fee === null && p.rate_type === null)).toBe(true);
    const withoutRates = calculatePackages(products, [box('six', 6)], sizes, [], { ...settings, yamato_rates_enabled: false, multi_parcel_discount_enabled: true, multi_parcel_discount_amount: 100 });
    expect(withoutRates.packages.every(p => p.size_code !== null && p.shipping_fee === null && p.rate_type === null)).toBe(true);
    expect(withoutRates.discount_amount).toBe(0);
  });
  it('chooses six plus two for eight one-sho bottles and keeps groups separate', () => {
    const boxes = [box('large-6', 6, [1800]), box('large-2', 2, [1800]), box('large-1', 1, [1800]), box('small-6', 6)];
    const result = calculatePackages([item('large', 1800, 8, 2.7), item('small', 700, 1)], boxes, sizes, rates, settings);
    expect(result.packages).toHaveLength(3);
    expect(result.packages.slice(0, 2).map((p) => p.packaging_box_id).sort()).toEqual(['large-2', 'large-6']);
    expect(result.packages.flatMap((p) => p.items).reduce((n, i) => n + i.quantity, 0)).toBe(9);
    expect(result.packages.every((p) => p.items.length === 1)).toBe(true);
  });
  it('mixes eligible 300/500/700ml products in one parcel, preserving quantities and lines', () => {
    const products = [{ ...item('a', 300, 2, .6), line_no: 1 }, { ...item('b', 500, 2, .9), line_no: 2 }, { ...item('c', 700, 2, 1.2), line_no: 3 }];
    const result = calculatePackages(products, [box('six', 6)], sizes, rates, settings);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.items).toEqual([{ product_id: 'a', quantity: 2, line_no: 1 }, { product_id: 'b', quantity: 2, line_no: 2 }, { product_id: 'c', quantity: 2, line_no: 3 }]);
    expect(result.packages[0]!.total_weight_kg).toBe(5.9);
    expect(result.packages[0]!.size_code).toBe('100');
  });
  it('obeys product-specific no-mixing boxes', () => {
    const result = calculatePackages([item('a', 300, 2), item('b', 300, 2)], [{ ...box('six', 6), allow_mixed: 0 }], sizes, rates, settings);
    expect(result.packages).toHaveLength(2);
    expect(result.packages.every((p) => p.items.length === 1)).toBe(true);
  });
  it('selects the larger size required by either weight or dimensions', () => {
    expect(determineYamatoSize(59, 8, sizes).size_code).toBe('100');
    expect(determineYamatoSize(119, 1, sizes).size_code).toBe('120');
    expect(determineYamatoSize(160, 25, sizes).size_code).toBe('160');
    expect(() => determineYamatoSize(160, 25.01, sizes)).toThrow();
  });
  it('splits overweight parcels within the largest allowed size', () => {
    const result = calculatePackages([item('heavy', 700, 6, 5)], [box('six', 6)], sizes, rates, settings);
    expect(result.packages).toHaveLength(2);
    expect(result.packages.every((p) => p.total_weight_kg <= 25)).toBe(true);
  });
  it('optimizes constrained box support without losing items', () => {
    const result = calculatePackages([item('a', 300, 3), item('b', 700, 3)], [box('three-a', 3, [300]), box('mixed-four', 4, [300, 700])], sizes, rates, settings);
    expect(result.packages).toHaveLength(2);
    expect(result.packages.flatMap((p) => p.items).filter((i) => i.product_id === 'a').reduce((n, i) => n + i.quantity, 0)).toBe(3);
    expect(result.packages.flatMap((p) => p.items).filter((i) => i.product_id === 'b').reduce((n, i) => n + i.quantity, 0)).toBe(3);
  });
  it('does not silently set shipping to zero when a fare or packing master is missing', () => {
    expect(() => calculatePackages([item('a', 300, 1)], [box('six', 6)], sizes, [], settings)).toThrow('運賃が未設定');
    expect(() => calculatePackages([item('a', 300, 1)], [], sizes, rates, settings)).toThrow('梱包箱');
    expect(() => calculatePackages([item('a', 300, 1)], [box('six', 6)], [], rates, settings)).toThrow('ヤマトサイズ');
  });
  it('uses currently effective contract rates over standard rates', () => {
    const custom: YamatoRate[] = [...rates, { dest_region: '東京都', size_code: '80', shipping_fee: 500, rate_type: 'contract', valid_from: '2026-01-01' }, { dest_region: '東京都', size_code: '80', shipping_fee: 1, rate_type: 'contract', valid_from: '2027-01-01' }];
    expect(calculatePackages([item('a', 300, 1)], [box('six', 6)], sizes, custom, settings).shipping_fee).toBe(500);
  });
  it('never discounts the total below zero and discounts only multiple parcels', () => {
    const discounted = { ...settings, multi_parcel_discount_enabled: 'true', multi_parcel_discount_amount: '10000' };
    const result = calculatePackages([item('a', 300, 8)], [box('six', 6)], sizes, rates, discounted);
    expect(result.shipping_fee).toBe(0);
    expect(result.discount_amount).toBe(result.packages.reduce((n, p) => n + (p.shipping_fee ?? 0), 0));
    expect(calculatePackages([item('a', 300, 1)], [box('six', 6)], sizes, rates, discounted).discount_amount).toBe(0);
    expect(calculatePackages([item('a', 300, 8)], [box('six', 6)], sizes, rates, { ...discounted, multi_parcel_discount_enabled: 'false' }).shipping_fee).toBeGreaterThan(0);
  });
  it('makes own delivery explicitly free without requiring Yamato masters', () => {
    expect(calculatePackages([item('a', 300, 5)], [], [], [], { ...settings, delivery_method: 'own_delivery' })).toEqual({ packages: [], shipping_fee: 0, discount_amount: 0 });
  });
  it('honors validity periods and rejects duplicate products or invalid weights', () => {
    expect(() => calculatePackages([item('a', 300, 1)], [{ ...box('six', 6), valid_to: '2026-10-18' }], sizes, rates, settings)).toThrow();
    expect(() => calculatePackages([item('a', 300, 1), item('a', 300, 1)], [box('six', 6)], sizes, rates, settings)).toThrow('重複');
    expect(() => calculatePackages([item('a', 300, 1, 0)], [box('six', 6)], sizes, rates, settings)).toThrow('重量');
  });
  it('handles a large ordinary order with count DP rather than exponential search', () => {
    const result = calculatePackages([item('a', 300, 1200)], [box('six', 6), box('twelve', 12)], sizes, rates, settings);
    expect(result.packages).toHaveLength(100);
    expect(result.packages.every((p) => p.items[0]!.quantity === 12)).toBe(true);
  });
});
