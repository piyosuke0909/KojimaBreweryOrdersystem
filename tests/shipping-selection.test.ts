import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePricing, matchesShippingRule, selectAutomaticShippingRule, type AutomaticShippingRule } from '../src/domain';
import { app } from '../src/server';
import { signSession } from '../src/server/auth';
import type { Bindings } from '../src/server/types';
import { migrateTestDatabase } from './helpers/migrate';

const rule = (id: string, target: unknown = {}, method = 'yamato'): AutomaticShippingRule => ({ id, target_condition_json: JSON.stringify(target), delivery_method: method, status: 'active' });

describe('automatic shipping target selection', () => {
  it('honors a Yamato city restriction instead of selecting a different region free rule', () => {
    const tokyo = rule('tokyo-free', { cities: ['新宿区'] }), national = rule('national');
    expect(selectAutomaticShippingRule([tokyo, national], { city: '大阪市' })?.id).toBe('national');
    expect(selectAutomaticShippingRule([national, tokyo], { city: '新宿区' })?.id).toBe('tokyo-free');
  });
  it('honors empty city targets for own delivery as the documented all-region rule', () => {
    for (const target of [{}, { cities: [] }, []]) {
      expect(selectAutomaticShippingRule([rule('yamato'), rule('own', target, 'own_delivery')], { city: '大阪市' })?.id).toBe('own');
    }
  });
  it('uses exact city names for both methods and accepts existing city/list forms', () => {
    for (const method of ['own_delivery', 'yamato']) for (const target of [{ city: '犬山市' }, { city: ['犬山市'] }, { cities: [' 犬山市 '] }, ['犬山市']]) {
      const candidate = rule('city-rule', target, method);
      expect(matchesShippingRule(candidate, { city: '犬山市' })).toBe(true);
      expect(matchesShippingRule(candidate, { city: '犬山' })).toBe(false);
      expect(matchesShippingRule(candidate, { city: '犬山市外' })).toBe(false);
      expect(matchesShippingRule(candidate, {})).toBe(false);
    }
  });
  it('gives matched own delivery precedence and resolves equally specific matches by ID', () => {
    const own = rule('z-own', {}, 'own_delivery'), national = rule('a-national'), city = rule('z-city', { cities: ['犬山市'] });
    expect(selectAutomaticShippingRule([city, national, own], { city: '犬山市' })?.id).toBe('z-own');
    for (const rules of [[rule('b'), rule('a')], [rule('a'), rule('b')]]) expect(selectAutomaticShippingRule(rules, {})?.id).toBe('a');
  });
  it('never interprets distance or unknown restrictions as a nationwide free rule', () => {
    const manual = rule('own-with-distance', { max_distance_km: 45 }, 'own_delivery');
    expect(matchesShippingRule(manual, { city: '犬山市' })).toBe(false);
    expect(selectAutomaticShippingRule([manual, rule('national')], { city: '犬山市' })?.id).toBe('national');
    expect(selectAutomaticShippingRule([rule('unsupported', { postal_prefix: '484' }, 'own_delivery')], { city: '犬山市' })).toBeNull();
    expect(matchesShippingRule(rule('partially-unknown', { cities: ['犬山市'], max_distance_km: 45 }, 'own_delivery'), { city: '犬山市' })).toBe(false);
  });
  it('ignores inactive and deleted rules, including their unused invalid data', () => {
    const invalid = { ...rule('inactive', {}, 'own_delivery'), target_condition_json: 'broken', status: 'inactive' };
    const deleted = { ...rule('deleted', {}, 'own_delivery'), deleted_at: '2026-10-24' };
    expect(selectAutomaticShippingRule([invalid, deleted, rule('national')], {} as any)?.id).toBe('national');
  });
  it('fails closed for malformed JSON and invalid city lists', () => {
    for (const target_condition_json of ['{', 'null', '3', '{"cities":"大阪市"}', '{"cities":[1]}', '{"cities":[""]}', '{"cities":[],"city":"大阪市"}']) {
      expect(() => selectAutomaticShippingRule([{ ...rule('invalid'), target_condition_json }, rule('fallback')], { city: '大阪市' })).toThrow();
    }
  });
  it('returns no automatic rule when every regional rule excludes the destination', () => {
    expect(selectAutomaticShippingRule([rule('tokyo', { cities: ['新宿区'] }), rule('aichi', { cities: ['犬山市'] }, 'own_delivery')], { city: '大阪市' })).toBeNull();
  });
});

describe('exact yen tax rounding', () => {
  it('does not move an extreme but safe integer-yen amount across a tax boundary', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ unit_price: 1_000_000_000 - ((3 + i * 137) % 1000) - (i === 99 ? 3 : 0), quantity: 9999 }));
    expect(computePricing(lines, { tax_rate: 30, tax_rounding: 'floor' }).tax_amount).toBe(299_969_854_655_535);
    expect(computePricing(lines, { tax_rate: 30, tax_rounding: 'ceil' }).tax_amount).toBe(299_969_854_655_536);
    expect(computePricing(lines, { tax_rate: 30, tax_rounding: 'round' }).tax_amount).toBe(299_969_854_655_536);
  });
  it('preserves exact integer boundaries for decimal rates and large yen amounts', () => {
    for (const tax_rounding of ['floor', 'ceil', 'round'] as const) {
      expect(computePricing([{ unit_price: 10_000, quantity: 1 }], { tax_rate: '8.1', tax_rounding }).tax_amount).toBe(810);
      expect(computePricing([{ unit_price: 1_000_000_000_000_000, quantity: 1 }], { tax_rate: '8.1', tax_rounding }).tax_amount).toBe(81_000_000_000_000);
    }
  });
  it('rounds decimal percentages and scientific notation without an epsilon allowance', () => {
    expect(computePricing([{ unit_price: 100, quantity: 1 }], { tax_rate: '8.1', tax_rounding: 'floor' }).tax_amount).toBe(8);
    expect(computePricing([{ unit_price: 100, quantity: 1 }], { tax_rate: '8.1', tax_rounding: 'ceil' }).tax_amount).toBe(9);
    expect(computePricing([{ unit_price: 1, quantity: 1 }], { tax_rate: 1e-7, tax_rounding: 'ceil' }).tax_amount).toBe(1);
    expect(computePricing([{ unit_price: 10_000_000_000, quantity: 1 }], { tax_rate: 1e-7, tax_rounding: 'floor' }).tax_amount).toBe(10);
  });
  it('rounds positive half-yen amounts upward only for half-up or ceiling modes', () => {
    const lines = [{ unit_price: 5, quantity: 1 }];
    expect(computePricing(lines, { tax_rate: 10, tax_rounding: 'floor' }).tax_amount).toBe(0);
    expect(computePricing(lines, { tax_rate: 10, tax_rounding: 'ceil' }).tax_amount).toBe(1);
    expect(computePricing(lines, { tax_rate: 10, tax_rounding: 'round' }).tax_amount).toBe(1);
  });
});

class SqliteD1 {
  sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  execute() {
    const statement = this.db.sqlite.prepare(this.sql);
    const result = statement.columns().length ? statement.all(...this.args) : statement.run(...this.args);
    const changes = (this.db.sqlite.prepare('SELECT changes() AS count').get() as any).count;
    return { success: true, results: Array.isArray(result) ? result : [], meta: { changes: Number(changes) } };
  }
}

describe('automatic shipping over authenticated quote routes', () => {
  let db: SqliteD1, env: Bindings, cookie: string;
  beforeEach(async () => {
    db = new SqliteD1(); migrateTestDatabase(db.sqlite);
    db.sqlite.exec(readFileSync(new URL('../seeds/demo.sql', import.meta.url), 'utf8'));
    db.sqlite.exec("INSERT INTO admins(id,login_id,password_hash,name,role) VALUES('shipping-owner','shipping-owner','unused','管理者','owner'); UPDATE shipping_rules SET status='inactive' WHERE delivery_method='own_delivery'; UPDATE shipping_addresses SET shipping_rule_id=NULL,prefecture='大阪府',city='大阪市' WHERE id='address-b';");
    env = { DB: db.binding(), APP_ENV: 'development', ALLOW_DEMO_AUTH: 'false', SESSION_SECRET: 'shipping-selection-only-signing-key-longer-than-32' } as Bindings;
    cookie = 'kojima_session=' + await signSession({ id: 'shipping-owner', type: 'admin', name: '管理者', role: 'owner' }, env);
  });
  afterEach(() => db.sqlite.close());
  async function request(path: string, input?: unknown) {
    const response = await app.request('https://shipping.example/api/admin' + path, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: 'https://shipping.example', 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env);
    return { status: response.status, value: await response.json() as any };
  }
  async function quote() {
    const dates = await request('/companies/company-b/delivery-dates?shipping_address_id=address-b');
    expect(dates.status, JSON.stringify(dates.value)).toBe(200);
    return request('/orders/quote', { company_id: 'company-b', shipping_address_id: 'address-b', desired_delivery_date: dates.value.data[0], items: [{ product_id: 'samurai-300', quantity: 2 }] });
  }
  it('charges the national fare for Osaka instead of a city-limited free Yamato fare', async () => {
    db.sqlite.exec("UPDATE shipping_rules SET target_condition_json='{\"cities\":[\"新宿区\"]}',is_free_shipping=1 WHERE id='RULE_YAMATO'; INSERT INTO shipping_rules(id,name,target_condition_json,delivery_method,allowed_periods_json,is_free_shipping,status) VALUES('NATIONAL','全国通常送料','{}','yamato','[]',0,'active');");
    const automatic = await quote(); expect(automatic.status, JSON.stringify(automatic.value)).toBe(200);
    expect(automatic.value.data.shipping_fee).toBe(1100); expect(automatic.value.data.total_amount).toBe(6270);
    db.sqlite.exec("UPDATE shipping_addresses SET shipping_rule_id='NATIONAL' WHERE id='address-b'");
    const explicit = await quote(); expect(explicit.value.data.shipping_fee).toBe(automatic.value.data.shipping_fee);
  });
  it('uses an all-region own-delivery rule automatically and retains explicit manual distance assignments', async () => {
    db.sqlite.exec("INSERT INTO shipping_rules(id,name,target_condition_json,delivery_method,allowed_periods_json,is_free_shipping,status) VALUES('OWN_ALL','全域自社便','{\"cities\":[]}','own_delivery','[]',1,'active');");
    const automatic = await quote(); expect(automatic.status, JSON.stringify(automatic.value)).toBe(200);
    expect(automatic.value.data.delivery_method).toBe('own_delivery'); expect(automatic.value.data.shipping_fee).toBe(0);
    db.sqlite.exec("UPDATE shipping_addresses SET shipping_rule_id='RULE_AREA_B' WHERE id='address-b'; UPDATE shipping_rules SET status='active',allowed_periods_json='[]' WHERE id='RULE_AREA_B'");
    const explicit = await quote(); expect(explicit.status, JSON.stringify(explicit.value)).toBe(200);
    expect(explicit.value.data.delivery_method).toBe('own_delivery'); expect(explicit.value.data.shipping_fee).toBe(0);
  });
  it('rejects automatic delivery when no regional rule matches rather than choosing an arbitrary fare', async () => {
    db.sqlite.exec("UPDATE shipping_rules SET target_condition_json='{\"cities\":[\"新宿区\"]}' WHERE id='RULE_YAMATO'");
    const dates = await request('/companies/company-b/delivery-dates?shipping_address_id=address-b');
    expect(dates.status).toBe(422); expect(dates.value.error.code).toBe('SHIPPING_RULE_MISSING');
  });
});
