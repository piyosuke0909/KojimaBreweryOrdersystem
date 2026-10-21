import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { DomainError } from '../../domain';

export type Row = Record<string, any>;
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const actor = (c: Context<AppEnv>) => c.get('actor');
export async function rows(db: D1Database, sql: string, ...args: any[]): Promise<Row[]> {
  return (await db.prepare(sql).bind(...args.map(v => v === undefined ? null : v)).all<Row>()).results;
}
export const one = async (db: D1Database, sql: string, ...args: any[]) => db.prepare(sql).bind(...args.map(v => v === undefined ? null : v)).first<Row>();
export function insert(db: D1Database, table: string, data: Row) {
  const fields = Object.keys(data);
  return db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).bind(...fields.map(k => data[k] ?? null));
}
/** Keep D1 query and bind counts low when persisting order/invoice collections. */
export function insertMany(db:D1Database,table:string,data:Row[]) {
  if(!data.length) return [];
  const fields=Object.keys(data[0]!);
  return [db.prepare(`INSERT INTO ${table} (${fields.join(',')}) SELECT ${fields.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`).bind(JSON.stringify(data))];
}
export function update(db: D1Database, table: string, data: Row, where: string, ...args: any[]) {
  const fields = Object.keys(data);
  return db.prepare(`UPDATE ${table} SET ${fields.map(k => `${k}=?`).join(',')} WHERE ${where}`).bind(...fields.map(k => data[k] ?? null), ...args);
}
export function audit(db: D1Database, who: Row, action: string, table: string, id: string, before: any, after: any, companyId?: string) {
  return insert(db, 'audit_logs', {id:uid(), acted_at:now(), actor_type:who.type, actor_id:who.id, company_id:companyId || who.company_id || null, action, target_type:table, target_id:id, before_json:before == null ? null : JSON.stringify(before), after_json:after == null ? null : JSON.stringify(after)});
}
/** A failed invariant deliberately violates audit_logs.action NOT NULL, rolling back the entire D1 batch. */
export function assertChanges(db: D1Database, expected: number, who: Row, action: string, table: string, id: string, before: any, after: any, companyId?: string) {
  return db.prepare(`INSERT INTO audit_logs (id,acted_at,actor_type,actor_id,company_id,action,target_type,target_id,before_json,after_json) VALUES (?,?,?,?,?,CASE WHEN changes()=? THEN ? ELSE NULL END,?,?,?,?)`).bind(uid(),now(),who.type,who.id,companyId || who.company_id || null,expected,action,table,id,before == null ? null : JSON.stringify(before),after == null ? null : JSON.stringify(after));
}
export async function atomic(db: D1Database, statements: D1PreparedStatement[]) {
  try { return await db.batch(statements); }
  catch (error) {
    if (String(error).includes('NOT NULL constraint failed: audit_logs.action')) fail(409,'CONFLICT','データが更新されました。再読み込みしてもう一度お試しください。');
    throw error;
  }
}
const shippingSettingDefaults = { packing_enabled: 'true', yamato_sizes_enabled: 'true', yamato_rates_enabled: 'true', manual_shipping_fee: '' };
export const settings = async (db: D1Database) => ({...shippingSettingDefaults,...Object.fromEntries((await rows(db,'SELECT key,value FROM settings')).map(r=>[r.key,r.value]))});
export const pagination = (c: Context<AppEnv>,defaultSize=50) => ({page:Math.max(1, Math.min(100000,Math.floor(Number(c.req.query('page'))) || 1)), page_size:Math.max(1,Math.min(1000,Math.floor(Number(c.req.query('page_size'))) || defaultSize))});
export async function paginated(c: Context<AppEnv>, table: string, where = '1=1', args: any[] = [], order = 'id DESC', select = '*', defaultSize=50) {
  const {page,page_size} = pagination(c,defaultSize);
  const count = await one(c.env.DB,`SELECT count(*) AS total FROM ${table} WHERE ${where}`,...args);
  const data = await rows(c.env.DB,`SELECT ${select} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,...args,page_size,(page-1)*page_size);
  return c.json({data,meta:{total:Number(count?.total || 0),page,page_size}});
}
export async function body(c: Context<AppEnv>): Promise<Row> {
  let value: unknown;
  try { value=await c.req.json(); } catch { fail(400,'INVALID_JSON','JSON形式の入力が必要です。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'INVALID_INPUT','入力形式が不正です。');
  return value as Row;
}
export function string(value: any, name: string, required = true, max = 2000): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) fail(400,'INVALID_INPUT',`${name}を正しく入力してください。`);
  return value.trim();
}
export function integer(value: any, name: string, min = 0, max = 1000000000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400,'INVALID_INPUT',`${name}は${min}〜${max}の整数で指定してください。`);
  return value;
}
export function date(value: any, name: string): string {
  const v=string(value,name,true,10);
  const parsed=new Date(v+'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==v) fail(400,'INVALID_INPUT',`${name}の日付が不正です。`);
  return v;
}
export function number(value: any, name: string, min = 0, max = 1000000000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(400,'INVALID_INPUT',`${name}の数値が不正です。`);
  return value;
}
export const asJson = (value: any) => typeof value === 'string' ? value : JSON.stringify(value);
export function routerError(error: Error, c: Context<AppEnv>) {
  if (error instanceof ApiError) return c.json({error:{code:error.code,message:error.message}},error.status as any);
  if (error instanceof DomainError) return c.json({error:{code:error.code,message:error.message}},422);
  throw error;
}
