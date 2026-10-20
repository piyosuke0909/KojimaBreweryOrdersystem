/** Pure business rules. Money uses integer yen, calendar dates use JST, and no I/O occurs here. */
export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}

type Numeric = number | string;
type Flag = boolean | number | string;
export type TaxRounding = 'floor' | 'ceil' | 'round';
export type TaxUnit = 'invoice' | 'order' | 'item';
export interface PricingLine { unit_price: number; quantity: number }
export interface PricingSettings {
  tax_rate?: Numeric;
  tax_calc_unit?: TaxUnit;
  tax_rounding?: TaxRounding;
  shipping_taxable?: Flag;
  shipping_fee?: number;
}
export interface PricingResult {
  items_subtotal: number;
  shipping_fee: number;
  tax_amount: number;
  total_amount: number;
  is_reference_tax: boolean;
}
function integer(value: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new DomainError('INVALID_NUMBER', `${label}には${min}以上の整数を指定してください。`);
  return value;
}
function numeric(value: Numeric | undefined, fallback: number, label: string, min = 0): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min) throw new DomainError('INVALID_NUMBER', `${label}が不正です。`);
  return n;
}
function enabled(value: Flag | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  throw new DomainError('INVALID_FLAG', '真偽値の設定が不正です。');
}
function roundTax(amount: number, rate: number, rounding: TaxRounding): number {
  // Adding epsilon makes decimal rates such as 8.1% stable at integer boundaries.
  const raw = amount * rate / 100;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(raw)) * 2;
  if (rounding === 'floor') return Math.floor(raw + epsilon);
  if (rounding === 'ceil') return Math.ceil(raw - epsilon);
  return Math.round(raw);
}
export function computePricing(lines: PricingLine[], settings: PricingSettings = {}): PricingResult {
  const rate = numeric(settings.tax_rate, 10, '税率');
  if (rate > 100) throw new DomainError('INVALID_TAX_RATE', '税率は0〜100%で指定してください。');
  const rounding = settings.tax_rounding ?? 'floor';
  const unit = settings.tax_calc_unit ?? 'invoice';
  if (!['floor', 'ceil', 'round'].includes(rounding) || !['invoice', 'order', 'item'].includes(unit)) throw new DomainError('INVALID_TAX_SETTING', '税計算設定が不正です。');
  const amounts = lines.map((line) => integer(integer(line.unit_price, '単価') * integer(line.quantity, '数量', 1), '明細金額'));
  const items_subtotal = integer(amounts.reduce((sum, n) => sum + n, 0), '商品小計');
  const shipping_fee = integer(settings.shipping_fee ?? 0, '送料');
  const taxableShipping = enabled(settings.shipping_taxable, true) ? shipping_fee : 0;
  const tax_amount = integer(unit === 'item'
    ? amounts.reduce((sum, amount) => sum + roundTax(amount, rate, rounding), 0) + roundTax(taxableShipping, rate, rounding)
    : roundTax(items_subtotal + taxableShipping, rate, rounding), '消費税');
  return { items_subtotal, shipping_fee, tax_amount, total_amount: integer(items_subtotal + shipping_fee + tax_amount, '税込合計'), is_reference_tax: unit === 'invoice' };
}

export interface CalendarDay { date: string; is_deliverable: Flag }
export interface DeliveryRule { allowed_periods_json?: string; delivery_method?: string; status?: string }
export interface CalendarSettings { min_lead_business_days?: Numeric; cancel_business_days?: Numeric; cancel_cutoff_time?: string }
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(date: string): void {
  if (!DATE_PATTERN.test(date)) throw new DomainError('INVALID_DATE', '日付はYYYY-MM-DD形式で指定してください。');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new DomainError('INVALID_DATE', '日付が不正です。');
}
function dayAfter(date: string, delta: number): string {
  assertDate(date);
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + delta * 86_400_000).toISOString().slice(0, 10);
}
export function jstDate(now: Date | string): string {
  const n = new Date(now).getTime();
  if (!Number.isFinite(n)) throw new DomainError('INVALID_DATE', '日時が不正です。');
  return new Date(n + 9 * 3_600_000).toISOString().slice(0, 10);
}
/** A date absent from the maintained calendar is unavailable, including weekdays. */
export function isBusinessDay(date: string, calendar: CalendarDay[]): boolean {
  assertDate(date);
  const row = calendar.find((day) => day.date === date);
  return row !== undefined && enabled(row.is_deliverable);
}
export function addBusinessDays(date: string, count: number, calendar: CalendarDay[]): string {
  assertDate(date);
  if (!Number.isSafeInteger(count)) throw new DomainError('INVALID_NUMBER', '営業日数は整数で指定してください。');
  if (count === 0) return date;
  const dates = calendar.filter((day) => enabled(day.is_deliverable) && (count > 0 ? day.date > date : day.date < date)).map((day) => day.date).sort();
  const unique = [...new Set(dates)];
  const result = count > 0 ? unique[count - 1] : unique[unique.length + count];
  if (!result) throw new DomainError('CALENDAR_INCOMPLETE', '必要な営業日が配送カレンダーに登録されていません。');
  assertDate(result);
  return result;
}
function withinPeriods(date: string, rule: DeliveryRule): boolean {
  let periods: { start_day: number; end_day: number }[];
  try { periods = JSON.parse(rule.allowed_periods_json ?? '[]') as typeof periods; }
  catch { throw new DomainError('INVALID_DELIVERY_RULE', '配送可能期間の設定が不正です。'); }
  if (!Array.isArray(periods) || periods.some((p) => !p || !Number.isInteger(p.start_day) || !Number.isInteger(p.end_day) || p.start_day < 1 || p.end_day > 31 || p.start_day > p.end_day)) throw new DomainError('INVALID_DELIVERY_RULE', '配送可能期間の設定が不正です。');
  const day = Number(date.slice(8));
  return periods.length === 0 || periods.some((period) => day >= period.start_day && day <= period.end_day);
}
export function getDeliveryDates(now: Date | string, rule: DeliveryRule, calendar: CalendarDay[], settings: CalendarSettings = {}): string[] {
  if (rule.status && rule.status !== 'active') return [];
  const lead = integer(numeric(settings.min_lead_business_days, 4, '最短リードタイム'), '最短リードタイム');
  const earliest = addBusinessDays(jstDate(now), lead, calendar);
  return [...new Set(calendar.filter((row) => row.date >= earliest && enabled(row.is_deliverable) && withinPeriods(row.date, rule)).map((row) => { assertDate(row.date); return row.date; }))].sort();
}
/** Deadline includes its exact cutoff instant; the following millisecond is too late. */
export function cancellationDeadline(deliveryDate: string, calendar: CalendarDay[], settings: CalendarSettings = {}): string {
  const days = integer(numeric(settings.cancel_business_days, 3, '変更・キャンセル期限'), '変更・キャンセル期限');
  const cutoff = settings.cancel_cutoff_time ?? '17:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) throw new DomainError('INVALID_CUTOFF', '締切時刻はHH:mm形式で指定してください。');
  return `${addBusinessDays(deliveryDate, -days, calendar)}T${cutoff}:00+09:00`;
}
export interface EditableOrder { status: string; is_invoice_locked: Flag; desired_delivery_date: string; edit_lock_status?: string; edit_lock_expires_at?: string | null; edit_locked_by?: string | null }
export function canEditOrder(order: EditableOrder, now: Date | string, calendar: CalendarDay[], settings: CalendarSettings = {}): boolean {
  if (!['received', 'confirmed'].includes(order.status) || enabled(order.is_invoice_locked)) return false;
  const at = new Date(now).getTime();
  if (!Number.isFinite(at)) throw new DomainError('INVALID_DATE', '日時が不正です。');
  return at <= new Date(cancellationDeadline(order.desired_delivery_date, calendar, settings)).getTime();
}
export const canEdit = canEditOrder;

export interface PackingItem { product_id: string; volume_ml: number; weight_kg: number; quantity: number; line_no?: number }
export interface PackagingBox { id: string; name?: string; supported_volumes_json: string; max_bottles: number; length_cm: number; width_cm: number; height_cm: number; box_weight_kg: number; allow_mixed: Flag; priority: number; valid_from?: string | null; valid_to?: string | null; status?: string }
export interface YamatoSize { size_code: string; max_three_sides_cm: number; max_weight_kg: number; valid_from?: string | null; valid_to?: string | null; status?: string }
export interface YamatoRate { id?: string; origin_region?: string; dest_region: string; size_code: string; shipping_fee: number; rate_type: 'standard' | 'contract'; valid_from?: string | null; valid_to?: string | null; status?: string }
export interface PackingSettings { dest_region: string; date?: string; origin_region?: string; delivery_method?: 'yamato' | 'own_delivery'; multi_parcel_discount_enabled?: Flag; multi_parcel_discount_amount?: Numeric }
export interface PackageItem { product_id: string; quantity: number; line_no?: number }
export interface CalculatedPackage { package_no: number; packaging_box_id: string; box_name: string; size_code: string; three_sides_cm: number; total_weight_kg: number; shipping_fee: number; rate_type: 'standard' | 'contract'; items: PackageItem[] }
interface Box extends PackagingBox { volumes: number[]; sides: number; maxWeight: number }
interface Plan { box: Box; counts: number[] }
function activeAt(row: { status?: string; valid_from?: string | null; valid_to?: string | null }, date: string): boolean {
  return (!row.status || row.status === 'active') && (!row.valid_from || row.valid_from <= date) && (!row.valid_to || row.valid_to >= date);
}
/** Smallest size satisfying BOTH dimension and weight limits, never merely one of them. */
export function determineYamatoSize(sides: number, weight: number, sizes: YamatoSize[]): YamatoSize {
  const size = [...sizes].sort((a, b) => a.max_three_sides_cm - b.max_three_sides_cm || a.max_weight_kg - b.max_weight_kg).find((s) => sides <= s.max_three_sides_cm && weight <= s.max_weight_kg + 1e-9);
  if (!size) throw new DomainError('PACKAGE_OVERSIZE', '梱包の大きさまたは重量が配送可能サイズを超えています。');
  return size;
}
function score(plans: Plan[]): number[] {
  return [plans.length, plans.reduce((n, p) => n + p.box.max_bottles - p.counts.reduce((a, b) => a + b, 0), 0), plans.reduce((n, p) => n + p.box.priority, 0)];
}
function compare(a: number[], b: number[]): number { for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; if (d) return d; } return 0; }
/** Common case is linear-time DP over bottle count. General mixed constraints use exact memoized packing. */
function packGroup(items: PackingItem[], boxes: Box[]): Plan[] {
  if (!items.length) return [];
  const total = integer(items.reduce((n, i) => n + i.quantity, 0), '合計本数', 1);
  if (total > 100_000) throw new DomainError('ORDER_TOO_LARGE', '1回の自動梱包は100,000本までです。注文を分けてください。');
  const maximumWeight = Math.max(...items.map((i) => i.weight_kg));
  const universal = boxes.filter((box) => (items.length === 1 || enabled(box.allow_mixed)) && items.every((i) => box.volumes.includes(i.volume_ml)) && maximumWeight * box.max_bottles + box.box_weight_kg <= box.maxWeight + 1e-9);
  if (universal.length === boxes.length && boxes.length) {
    // Store scalar costs and predecessor, rather than copying every partial package plan.
    const costs: number[][] = [[0, 0, 0]];
    const choices: Box[] = [];
    for (let n = 1; n <= total; n++) {
      let best: number[] | undefined;
      let chosen: Box | undefined;
      for (const box of universal) {
        const used = Math.min(n, box.max_bottles);
        const previous = costs[n - used]!;
        const cost = [previous[0]! + 1, previous[1]! + box.max_bottles - used, previous[2]! + box.priority];
        if (!best || compare(cost, best) < 0) { best = cost; chosen = box; }
      }
      costs[n] = best!; choices[n] = chosen!;
    }
    const remaining = items.map((i) => i.quantity);
    const plans: Plan[] = [];
    for (let n = total; n > 0;) {
      const box = choices[n]!;
      let capacity = Math.min(n, box.max_bottles);
      const counts = remaining.map((qty, i) => { const take = Math.min(qty, capacity); capacity -= take; remaining[i] = qty - take; return take; });
      const used = counts.reduce((a, b) => a + b, 0);
      plans.push({ box, counts }); n -= used;
    }
    return plans;
  }
  const memo = new Map<string, Plan[] | null>();
  let work = 0;
  function search(remaining: number[]): Plan[] | null {
    const key = remaining.join(',');
    if (memo.has(key)) return memo.get(key)!;
    const anchor = remaining.findIndex((n) => n > 0);
    if (anchor < 0) return [];
    if (++work > 50_000) throw new DomainError('PACKING_COMPLEXITY', '梱包条件の組み合わせが多すぎます。管理者が梱包設定を確認してください。');
    let best: Plan[] | null = null;
    for (const box of boxes) {
      if (!box.volumes.includes(items[anchor]!.volume_ml)) continue;
      const mixed = enabled(box.allow_mixed);
      const compatible = items.map((item, i) => remaining[i]! > 0 && box.volumes.includes(item.volume_ml) && (mixed || item.product_id === items[anchor]!.product_id));
      const counts = remaining.map(() => 0);
      function enumerate(i: number, slots: number, weight: number): void {
        if (++work > 200_000) throw new DomainError('PACKING_COMPLEXITY', '梱包条件の組み合わせが多すぎます。管理者が梱包設定を確認してください。');
        if (i === items.length) {
          if (!counts[anchor]) return;
          // Any optimal solution can contain a maximal anchor parcel. Moving another
          // compatible bottle into this parcel cannot increase the parcel count.
          if (slots > 0 && items.some((item, j) => compatible[j] && remaining[j]! > counts[j]! && weight + item.weight_kg <= box.maxWeight + 1e-9)) return;
          const rest = remaining.map((n, j) => n - counts[j]!);
          const tail = search(rest);
          if (!tail) return;
          const candidate = [{ box, counts: [...counts] }, ...tail];
          if (!best || compare(score(candidate), score(best)) < 0) best = candidate;
          return;
        }
        const max = compatible[i] ? Math.min(remaining[i]!, slots, Math.floor((box.maxWeight - weight + 1e-9) / items[i]!.weight_kg)) : 0;
        for (let take = max; take >= (i === anchor ? 1 : 0); take--) {
          counts[i] = take;
          enumerate(i + 1, slots - take, weight + take * items[i]!.weight_kg);
        }
        counts[i] = 0;
      }
      enumerate(0, box.max_bottles, box.box_weight_kg);
    }
    memo.set(key, best);
    return best;
  }
  const result = search(items.map((i) => i.quantity));
  if (!result) throw new DomainError('PACKAGING_UNAVAILABLE', '商品に適合する梱包箱または重量条件がありません。');
  return result;
}
export function calculatePackages(items: PackingItem[], boxes: PackagingBox[], sizes: YamatoSize[], rates: YamatoRate[], settings: PackingSettings): { packages: CalculatedPackage[]; shipping_fee: number; discount_amount: number } {
  const ids = new Set<string>();
  for (const item of items) {
    integer(item.quantity, '数量', 1); integer(item.volume_ml, '容量', 1);
    if (!item.product_id || ids.has(item.product_id)) throw new DomainError('INVALID_PRODUCT', '商品IDの重複または不足があります。');
    ids.add(item.product_id);
    if (!Number.isFinite(item.weight_kg) || item.weight_kg <= 0) throw new DomainError('INVALID_WEIGHT', '商品重量は0より大きい値を指定してください。');
  }
  if (settings.delivery_method === 'own_delivery' || items.length === 0) return { packages: [], shipping_fee: 0, discount_amount: 0 };
  const date = settings.date ?? jstDate(new Date());
  assertDate(date);
  const validSizes = sizes.filter((s) => activeAt(s, date));
  if (!validSizes.length) throw new DomainError('SIZE_UNAVAILABLE', '有効なヤマトサイズが設定されていません。');
  const validBoxes: Box[] = boxes.filter((b) => activeAt(b, date)).map((box) => {
    let volumes: number[];
    try { volumes = JSON.parse(box.supported_volumes_json) as number[]; } catch { throw new DomainError('INVALID_BOX', '梱包箱の対応容量が不正です。'); }
    if (!Array.isArray(volumes) || !volumes.length || volumes.some((v) => !Number.isSafeInteger(v) || v <= 0)) throw new DomainError('INVALID_BOX', '梱包箱の対応容量が不正です。');
    integer(box.max_bottles, '梱包上限', 1);
    if (![box.length_cm, box.width_cm, box.height_cm].every((n) => Number.isFinite(n) && n > 0) || !Number.isFinite(box.box_weight_kg) || box.box_weight_kg < 0) throw new DomainError('INVALID_BOX', '梱包箱の寸法または重量が不正です。');
    const sides = box.length_cm + box.width_cm + box.height_cm;
    const fitting = validSizes.filter((s) => sides <= s.max_three_sides_cm);
    return { ...box, volumes, sides, maxWeight: Math.max(0, ...fitting.map((s) => s.max_weight_kg)) };
  }).filter((box) => box.maxWeight > box.box_weight_kg).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const packages: CalculatedPackage[] = [];
  // A one-sho bottle is never mixed with the smaller glass bottles, even if a
  // mistakenly configured box claims to support both capacity groups.
  for (const group of [items.filter((i) => i.volume_ml === 1800), items.filter((i) => i.volume_ml !== 1800)]) {
    if (!group.length) continue;
    const compatible = validBoxes.filter((b) => group.some((i) => b.volumes.includes(i.volume_ml)));
    if (!compatible.length) throw new DomainError('PACKAGING_UNAVAILABLE', '商品に適合する有効な梱包箱がありません。');
    for (const plan of packGroup(group, compatible)) {
      const contents = group.flatMap((i, n) => plan.counts[n]! > 0 ? [{ product_id: i.product_id, quantity: plan.counts[n]!, ...(i.line_no !== undefined ? { line_no: i.line_no } : {}) }] : []);
      const weight = Math.round((plan.box.box_weight_kg + group.reduce((n, i, j) => n + i.weight_kg * plan.counts[j]!, 0)) * 1e9) / 1e9;
      const size = determineYamatoSize(plan.box.sides, weight, validSizes);
      const matching = rates.filter((r) => activeAt(r, date) && (r.origin_region ?? '中部') === (settings.origin_region ?? '中部') && r.dest_region === settings.dest_region && r.size_code === size.size_code).sort((a, b) => (a.rate_type === 'contract' ? 0 : 1) - (b.rate_type === 'contract' ? 0 : 1) || (b.valid_from ?? '').localeCompare(a.valid_from ?? '') || (a.id ?? '').localeCompare(b.id ?? ''));
      const rate = matching[0];
      if (!rate) throw new DomainError('RATE_UNAVAILABLE', `${settings.dest_region}・${size.size_code}サイズの有効な運賃が未設定です。`);
      integer(rate.shipping_fee, '運賃');
      packages.push({ package_no: packages.length + 1, packaging_box_id: plan.box.id, box_name: plan.box.name ?? plan.box.id, size_code: size.size_code, three_sides_cm: plan.box.sides, total_weight_kg: weight, shipping_fee: rate.shipping_fee, rate_type: rate.rate_type, items: contents });
    }
  }
  const gross = integer(packages.reduce((n, p) => n + p.shipping_fee, 0), '送料合計');
  const discount = integer(numeric(settings.multi_parcel_discount_amount, 0, '複数個口割引額'), '複数個口割引額');
  const discount_amount = packages.length > 1 && enabled(settings.multi_parcel_discount_enabled) ? Math.min(gross, discount) : 0;
  return { packages, shipping_fee: gross - discount_amount, discount_amount };
}
