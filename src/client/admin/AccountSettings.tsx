import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, Save } from 'lucide-react';
import { api } from './api';
import { ConfirmDialog, ErrorBox, FieldHelp, Loading } from './ui';
import './account-settings.css';

type Account={id:string;login_id:string;name:string;role:string;can_change_credentials?:boolean};
export default function AccountSettings(){
  const [account,setAccount]=useState<Account|null>(null),[login,setLogin]=useState(''),[current,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
  const [error,setError]=useState(''),[success,setSuccess]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
  const live=useRef(true),sending=useRef(false);
  useEffect(()=>{live.current=true;api<Account>('/api/admin/account').then(value=>{if(live.current){setAccount(value);setLogin(value.login_id);}}).catch(error=>{if(live.current)setError(error.message);});return()=>{live.current=false;};},[]);
  function review(event:FormEvent){
    event.preventDefault();setError('');setSuccess('');
    if(!/^[A-Za-z0-9._@+-]{3,100}$/.test(login.trim())){setError('ユーザー名は半角英数字と . _ @ + - を使い、3〜100文字で入力してください。');return;}
    if(password&&(password.length<12||password.length>200)){setError('新しいパスワードは12〜200文字で入力してください。');return;}
    if(password!==confirmation){setError('新しいパスワードの確認が一致しません。');return;}
    if(!current){setError('現在のパスワードを入力してください。');return;}
    setConfirm(true);
  }
  async function save(){
    if(sending.current||!account)return;sending.current=true;setBusy(true);setError('');
    try{
      const value=await api<Account>('/api/admin/account',{method:'PUT',body:JSON.stringify({login_id:login.trim(),current_password:current,...(password?{new_password:password,confirm_password:confirmation}:{})})});
      if(!live.current)return;
      setAccount(value);setLogin(value.login_id);setCurrent('');setPassword('');setConfirmation('');setSuccess('ログイン設定を変更しました。次回から新しい情報でログインしてください。ほかの端末のログインは解除しました。');setConfirm(false);
    }catch(error){if(live.current){setError(error instanceof Error?error.message:'保存できませんでした。');setConfirm(false);}}
    finally{sending.current=false;if(live.current)setBusy(false);}
  }
  return <section className="admin-card account-settings"><div className="admin-card-head"><div><h2>ログイン設定</h2><p className="admin-muted">ログイン中の管理者のユーザー名・パスワードを変更します。</p></div><KeyRound size={24}/></div><div className="account-settings-body"><ErrorBox error={error}/>{success&&<p className="admin-alert success" role="status">{success}</p>}{!account&&!error?<Loading/>:account&&<form onSubmit={review}>
    <div className="admin-alert info">変更には現在のパスワードが必要です。保存後は、この画面以外でログインしている同じ管理者の端末もログアウトします。</div>
    {account.can_change_credentials===false&&<div className="admin-alert info">デモ管理者のパスワードは自動生成されています。ログイン設定を変更する場合は、実際の管理者アカウントでログインしてください。</div>}
    <fieldset disabled={busy||account.can_change_credentials===false}><div className="admin-form-grid">
      <label className="admin-field span-2"><FieldHelp label="ログインユーザー名" help="半角英数字と . _ @ + - を使い、3〜100文字で指定します。管理者の表示名とは別の、ログイン時に入力するユーザー名です。"/><input className="admin-input" aria-label="ログインユーザー名" autoComplete="username" value={login} required minLength={3} maxLength={100} pattern="[A-Za-z0-9._@+\-]+" placeholder="例：kojima-admin" onChange={event=>setLogin(event.target.value)}/></label>
      <label className="admin-field span-2"><FieldHelp label="現在のパスワード" help="本人確認のため、現在ログインに使っているパスワードを入力してください。"/><input className="admin-input" aria-label="現在のパスワード" type="password" autoComplete="current-password" value={current} required maxLength={200} onChange={event=>setCurrent(event.target.value)}/></label>
      <label className="admin-field"><FieldHelp label="新しいパスワード" help="12〜200文字で設定します。ユーザー名だけを変える場合は、空欄のままにしてください。"/><input className="admin-input" aria-label="新しいパスワード" type="password" autoComplete="new-password" value={password} minLength={12} maxLength={200} placeholder="12文字以上（変更しない場合は空欄）" onChange={event=>setPassword(event.target.value)}/></label>
      <label className="admin-field"><FieldHelp label="新しいパスワード（確認）" help="入力間違いを防ぐため、新しいパスワードをもう一度入力してください。"/><input className="admin-input" aria-label="新しいパスワード（確認）" type="password" autoComplete="new-password" value={confirmation} required={!!password} maxLength={200} onChange={event=>setConfirmation(event.target.value)}/></label>
    </div></fieldset><div className="account-settings-actions"><button className="admin-btn primary" disabled={busy||account.can_change_credentials===false||login.trim()===account.login_id&&!password}><Save size={17}/>{busy?'保存中…':'変更内容を確認'}</button></div>
    </form>}</div><ConfirmDialog open={confirm} title="ログイン設定を変更しますか？" busy={busy} onClose={()=>{if(!busy)setConfirm(false);}} onConfirm={()=>void save()}><p>ログインユーザー名：{login.trim()}</p><p>{password?'パスワードも変更します。':'パスワードは変更しません。'}同じ管理者のほかのログインを解除します。新しい情報を保存してから続けてください。</p></ConfirmDialog></section>;
}
