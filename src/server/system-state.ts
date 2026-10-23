import { createMiddleware } from 'hono/factory';
import type { AppEnv, Bindings } from './types';
import { ApiError } from './services/common';

export type SystemState = { generation:number; data_revision:number };
type Guard = { database:D1Database; generation:number };
const databases=new WeakMap<D1Database,Guard>();
const statements=new WeakMap<D1PreparedStatement,{statement:D1PreparedStatement;sql:string}>();
const leaseLifetime=120_000;
const resetChanged=()=>new ApiError(409,'SYSTEM_RESET_CHANGED','システムが初期化されました。画面を開き直して再度ログインしてください。');
export const isSystemResetError=(error:unknown)=>error instanceof ApiError&&['SYSTEM_RESET_CHANGED','SYSTEM_TASK_EXPIRED'].includes(error.code);

export function unwrapSystemDatabase(db:D1Database):D1Database {return databases.get(db)?.database??db;}
export async function readSystemState(db:D1Database):Promise<SystemState>{
  const state=await unwrapSystemDatabase(db).prepare('SELECT generation,data_revision FROM system_state WHERE id=1').first<SystemState>();
  if(!state||!Number.isSafeInteger(state.generation)||!Number.isSafeInteger(state.data_revision))throw new ApiError(503,'SYSTEM_STATE_UNAVAILABLE','システムの初期化状態を確認できません。');
  return state;
}
/** An environment without a database is used only by standalone signing/provider tests. */
export async function getSystemGeneration(env:Pick<Bindings,'DB'>):Promise<number>{
  if(!env.DB)return 0;
  return databases.get(env.DB)?.generation??(await readSystemState(env.DB)).generation;
}
export async function assertSystemGeneration(env:Pick<Bindings,'DB'>):Promise<void>{
  if(env.DB&&(await readSystemState(env.DB)).generation!==await getSystemGeneration(env))throw resetChanged();
}
function generationCheck(db:D1Database,generation:number){
  // Invalid JSON aborts the entire D1 transaction before any business statement runs.
  return db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM system_state WHERE id=1 AND generation=?) THEN 'null' ELSE 'RESET_GENERATION_CHANGED' END)").bind(generation);
}
async function checked<T>(db:D1Database,generation:number,work:()=>Promise<T>):Promise<T>{
  try{return await work();}
  catch(error){if((await readSystemState(db)).generation!==generation)throw resetChanged();throw error;}
}
function mutates(sql:string){
  // These statements are authored by the server, never supplied by an API client.
  const tokens=sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]/g,' ').trim();
  if(/^(SELECT|EXPLAIN)\b/i.test(tokens))return false;
  if(/^WITH\b/i.test(tokens))return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(tokens);
  return true;
}
/** Fence every write in the same transaction as its epoch check, including RETURNING queries. */
export function guardDatabase(database:D1Database,generation:number):D1Database{
  const db=unwrapSystemDatabase(database);
  async function batch<T=unknown>(items:D1PreparedStatement[]):Promise<D1Result<T>[]>{
    const entries=items.map(statement=>statements.get(statement)??{statement,sql:''});
    // Unknown native statements are conservatively treated as writes.
    if(!entries.some(entry=>!entry.sql||mutates(entry.sql)))return db.batch<T>(entries.map(entry=>entry.statement));
    const result=await checked(db,generation,()=>db.batch<T>([
      generationCheck(db,generation),...entries.map(entry=>entry.statement),
      db.prepare('UPDATE system_state SET data_revision=data_revision+1 WHERE id=1'),
    ]));
    // Keep callers' result indices and adjacent SQLite changes() invariants intact.
    return result.slice(1,-1);
  }
  function prepare(sql:string,native=db.prepare(sql)):D1PreparedStatement{
    const wrapped=new Proxy(native,{
      get(target,property){
        if(property==='bind')return (...values:unknown[])=>prepare(sql,target.bind(...values));
        if(mutates(sql)){
          if(property==='run'||property==='all')return async()=> (await batch([wrapped]))[0];
          if(property==='first')return async(column?:string)=>{
            const row=(await batch<Record<string,unknown>>([wrapped]))[0].results?.[0];
            return column?row?.[column]??null:row??null;
          };
          if(property==='raw')return async(options?:{columnNames?:boolean})=>{
            const rows=(await batch<Record<string,unknown>>([wrapped]))[0].results??[];
            const values=rows.map(row=>Object.values(row));
            return options?.columnNames&&rows[0]?[Object.keys(rows[0]),...values]:values;
          };
        }
        const value=Reflect.get(target,property,target);
        return typeof value==='function'?value.bind(target):value;
      },
    });
    statements.set(wrapped,{statement:native,sql});return wrapped;
  }
  const wrapped=new Proxy(db,{
    get(target,property){
      if(property==='prepare')return prepare;
      if(property==='batch')return batch;
      // Runtime services use prepared statements exclusively; do not expose a write bypass.
      if(property==='exec'||property==='withSession')return ()=>{throw new ApiError(503,'SYSTEM_DATABASE_METHOD_UNSUPPORTED','このデータベース操作には対応していません。');};
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    },
  });
  databases.set(wrapped,{database:db,generation});return wrapped;
}
export const systemStateMiddleware=createMiddleware<AppEnv>(async(c,next)=>{
  if(c.env.DB){const original=c.env.DB,generation=(await readSystemState(original)).generation;c.env={...c.env,DB:guardDatabase(original,generation)};}
  await next();
  // An already-authorized read must not expose a new generation after a concurrent reset.
  await assertSystemGeneration(c.env);
});

export type SystemTask = { checkpoint:()=>Promise<void> };
/** A reset cannot commit while an external send is in flight. Expired work must renew before sending. */
export async function withSystemTask<T>(env:Bindings,kind:string,work:(task:SystemTask)=>Promise<T>):Promise<T>{
  if(!env.DB)return work({checkpoint:async()=>{}});
  const db=unwrapSystemDatabase(env.DB),generation=await getSystemGeneration(env),id=crypto.randomUUID();
  const leaseClock="strftime('%Y-%m-%dT%H:%M:%fZ','now')",leaseExpiry="strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds')";
  await checked(db,generation,()=>db.batch([
    generationCheck(db,generation),
    db.prepare(`INSERT INTO system_task_leases(id,generation,kind,expires_at) VALUES(?,?,?,${leaseExpiry})`).bind(id,generation,kind),
  ]));
  try{
    return await work({checkpoint:async()=>{
      const checkpointStarted=Date.now();
      const result=await checked(db,generation,()=>db.batch([
        generationCheck(db,generation),
        db.prepare(`UPDATE system_task_leases SET expires_at=${leaseExpiry} WHERE id=? AND generation=? AND expires_at>${leaseClock}`).bind(id,generation),
      ]));
      // A delayed D1 response must leave enough time for the bounded provider fetch.
      if(result[1].meta.changes!==1||Date.now()-checkpointStarted>leaseLifetime/2)throw new ApiError(409,'SYSTEM_TASK_EXPIRED','送信処理の有効時間が切れました。画面を開き直してください。');
    }});
  }finally{
    await db.prepare('DELETE FROM system_task_leases WHERE id=?').bind(id).run();
  }
}
