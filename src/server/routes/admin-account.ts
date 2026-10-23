import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { attachSession, checkPassword, hashPassword } from '../auth';
import { actor, assertChanges, atomic, body, fail, one } from '../services/common';

const inputSchema=z.object({
  login_id:z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._@+-]+$/,'ユーザー名は半角英数字と . _ @ + - で入力してください。'),
  current_password:z.string().min(1).max(200),
  new_password:z.string().min(12,'新しいパスワードは12文字以上で入力してください。').max(200).optional(),
  confirm_password:z.string().max(200).optional(),
}).strict().refine(value=>value.new_password===undefined?value.confirm_password===undefined:value.new_password===value.confirm_password,{message:'新しいパスワードの確認が一致しません。',path:['confirm_password']});
const attempts=new Map<string,{count:number;until:number}>();
const safe=(row:Record<string,any>)=>({id:row.id,login_id:row.login_id,name:row.name,role:row.role});
export const adminAccountRoutes=new Hono<AppEnv>();

adminAccountRoutes.get('/',async c=>{
  const who=actor(c);if(who.type!=='admin')fail(403,'ADMIN_REQUIRED','管理者としてログインしてください。');
  const row=await one(c.env.DB,"SELECT id,login_id,name,role FROM admins WHERE id=? AND status='active'",who.id);
  if(!row)fail(401,'ACCOUNT_INACTIVE','ログインし直してください。');
  return c.json({data:{...safe(row!),can_change_credentials:!(row!.id==='demo-admin'&&c.env.APP_ENV==='development')}});
});
adminAccountRoutes.put('/',async c=>{
  const who=actor(c);if(who.type!=='admin')fail(403,'ADMIN_REQUIRED','管理者としてログインしてください。');
  const input=inputSchema.parse(await body(c));
  const stamp=Date.now(),rate=attempts.get(who.id);
  if(rate&&rate.until>stamp&&rate.count>=8)fail(429,'PASSWORD_CHECK_RATE_LIMIT','しばらく待ってからもう一度お試しください。');
  const row=await one(c.env.DB,"SELECT id,login_id,password_hash,name,role,session_version FROM admins WHERE id=? AND status='active'",who.id);
  const expected=(who as typeof who&{session_version?:number}).session_version??0;
  if(!row||row.session_version!==expected)fail(409,'ACCOUNT_CHANGED','ログイン設定が変更されています。ログインし直してください。');
  if(!await checkPassword(input.current_password,row!.password_hash)){
    const next=rate&&rate.until>stamp?rate:{count:0,until:stamp+15*60*1000};next.count++;attempts.set(who.id,next);
    if(attempts.size>10000)for(const [id,value] of attempts)if(value.until<=stamp)attempts.delete(id);
    fail(400,'CURRENT_PASSWORD_INCORRECT','現在のパスワードが違います。');
  }
  const usernameChanged=input.login_id!==row!.login_id,passwordChanged=input.new_password!==undefined;
  if(passwordChanged&&input.new_password===input.current_password)fail(400,'PASSWORD_UNCHANGED','現在とは異なる新しいパスワードを入力してください。');
  if(!usernameChanged&&!passwordChanged)fail(400,'ACCOUNT_UNCHANGED','変更するユーザー名または新しいパスワードを入力してください。');
  const occupied=await one(c.env.DB,'SELECT id FROM admins WHERE login_id=? AND id!=?',input.login_id,who.id);
  if(occupied)fail(409,'LOGIN_ID_IN_USE','このユーザー名はすでに使われています。');
  const encoded=passwordChanged?await hashPassword(input.new_password!):row!.password_hash;
  const version=expected+1;
  try{
    await atomic(c.env.DB,[
      c.env.DB.prepare("UPDATE admins SET login_id=?,password_hash=?,session_version=? WHERE id=? AND status='active' AND login_id=? AND password_hash=? AND session_version=?")
        .bind(input.login_id,encoded,version,who.id,row!.login_id,row!.password_hash,expected),
      assertChanges(c.env.DB,1,who,'ADMIN_ACCOUNT_UPDATE','admins',who.id,null,{username_changed:usernameChanged,password_changed:passwordChanged,sessions_revoked:true}),
    ]);
  }catch(error){
    if(String(error).includes('UNIQUE constraint failed: admins.login_id'))fail(409,'LOGIN_ID_IN_USE','このユーザー名はすでに使われています。');
    throw error;
  }
  attempts.delete(who.id);
  const current={id:who.id,type:'admin' as const,name:row!.name,role:row!.role,session_version:version};
  await attachSession(c,current);
  return c.json({data:{...safe({...row,login_id:input.login_id}),changed:true}});
});
