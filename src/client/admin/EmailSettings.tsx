import { useEffect, useState, type FormEvent } from 'react';
import { Check, CircleCheck, Copy, ExternalLink, LoaderCircle, Mail, Plus, RefreshCw, Send, ShieldCheck, Trash2, Unplug } from 'lucide-react';
import { api } from './api';
import { ConfirmDialog, ErrorBox, FieldHelp } from './ui';
import './email-settings.css';

type MailSettings = {
  provider: 'gmail' | 'resend'; enabled: boolean; recipients: string[]; sender_email: string;
  notify_created: boolean; notify_edited: boolean; notify_cancelled: boolean;
  gmail_client_id: string; gmail_client_secret_configured: boolean; gmail_connected: boolean;
  redirect_uri: string; resend_configured: boolean;
};
type MailDraft = Pick<MailSettings, 'provider' | 'enabled' | 'recipients' | 'sender_email' | 'notify_created' | 'notify_edited' | 'notify_cancelled' | 'gmail_client_id'>;
type Callback = { code: string; state: string; error: boolean };
const endpoint = '/api/admin/mail-settings';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '処理に失敗しました。もう一度お試しください。';

// Capture before the administrator session check. Google credentials never enter
// browser storage, and authorization codes do not remain in the address bar.
let callback: Callback | null = (() => {
  if (typeof window === 'undefined' || window.location.pathname !== '/admin/settings/mail/callback') return null;
  const query = new URLSearchParams(window.location.search);
  const value = { code: query.get('code') || '', state: query.get('state') || '', error: query.has('error') };
  window.history.replaceState(window.history.state, '', '/admin/settings?tab=email');
  return value;
})();
let callbackRequest: Promise<MailSettings> | null = null;
export const hasPendingEmailOAuthCallback = () => !!callback;
function completeCallback(): Promise<MailSettings> | null {
  if (callbackRequest) return callbackRequest;
  if (!callback) return null;
  const value = callback;
  callback = null;
  callbackRequest = (value.error
    ? Promise.reject(new Error('Googleでの連携が取り消されました。設定を確認し、もう一度「Googleで連携」を押してください。'))
    : !value.code || !value.state
      ? Promise.reject(new Error('Googleからの連携情報が不足しています。もう一度「Googleで連携」を押してください。'))
      : api<MailSettings>(`${endpoint}/gmail/finish`, { method: 'POST', body: JSON.stringify({ code: value.code, state: value.state }) }))
    .finally(() => { callbackRequest = null; });
  return callbackRequest;
}
const draftOf = (value: MailSettings): MailDraft => ({
  provider: value.provider, enabled: value.enabled, recipients: value.recipients.length ? [...value.recipients] : [''],
  sender_email: value.sender_email, notify_created: value.notify_created, notify_edited: value.notify_edited,
  notify_cancelled: value.notify_cancelled, gmail_client_id: value.gmail_client_id,
});
const payloadOf = (value: MailDraft) => ({ ...value, recipients: value.recipients.map(item => item.trim()).filter(Boolean), sender_email: value.sender_email.trim(), gmail_client_id: value.gmail_client_id.trim() });

export default function EmailSettings({ owner }: { owner: boolean }) {
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [draft, setDraft] = useState<MailDraft | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [loading, setLoading] = useState(owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'disconnect' | 'test' | null>(null);
  const [revision, setRevision] = useState(0);
  const apply = (value: MailSettings) => { setSettings(value); setDraft(draftOf(value)); setClientSecret(''); };
  useEffect(() => {
    if (!owner) return;
    let active = true;
    setLoading(true); setError('');
    const pending = completeCallback();
    (pending || api<MailSettings>(endpoint)).then(value => {
      if (active) { apply(value); if (pending) setNotice('Googleとの連携が完了しました。通知先を確認してメール通知をオンにしてください。'); }
    }).catch(error => {
      if (active) setError(errorMessage(error));
      // A failed callback is never retried with the same one-use code. Load the
      // configuration so the administrator can explicitly start a new consent.
      if (pending) void api<MailSettings>(endpoint).then(value => { if (active) apply(value); }).catch(() => {});
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [owner, revision]);
  const dirty = !!draft && !!settings && (JSON.stringify(payloadOf(draft)) !== JSON.stringify(payloadOf(draftOf(settings))) || !!clientSecret);
  const connected = draft?.provider === 'gmail' ? settings?.gmail_connected : settings?.resend_configured;

  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy) return;
    const payload = payloadOf(draft);
    if (new Set(payload.recipients.map(value => value.toLowerCase())).size !== payload.recipients.length) { setError('同じ通知先が複数あります。重複したメールアドレスを削除してください。'); return; }
    if (draft.enabled && (!payload.recipients.length || (draft.provider === 'gmail' && !payload.sender_email))) { setError('メール通知をオンにする場合は、通知先とGmailの送信元を確認してください。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const previousClient = settings?.gmail_client_id;
      const previousConnection = settings?.gmail_connected;
      const value = await api<MailSettings>(endpoint, { method: 'PUT', body: JSON.stringify({ ...payload, ...(clientSecret ? { gmail_client_secret: clientSecret } : {}) }) });
      apply(value);
      setNotice(previousConnection && (previousClient !== value.gmail_client_id || clientSecret) ? '設定を保存しました。クライアント設定を変更したため、Googleで連携し直してください。' : 'メール設定を保存しました。');
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function connect() {
    if (busy || dirty) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ authorization_url: string }>(`${endpoint}/gmail/start`, { method: 'POST', body: '{}' });
      const target = new URL(result.authorization_url);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com' || target.username || target.password) throw new Error('Googleの連携先を確認できませんでした。');
      window.location.assign(target.href);
    } catch (error) { setError(errorMessage(error)); setBusy(false); }
  }
  async function confirmAction() {
    if (!confirm || busy) return;
    const action = confirm;
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'disconnect') {
        apply(await api<MailSettings>(`${endpoint}/gmail/disconnect`, { method: 'POST', body: '{}' }));
        setNotice('Googleとの連携を解除し、メール通知をオフにしました。');
      } else {
        const result = await api<{ status: 'sent' | 'disabled' | 'failed'; sent_count: number; failed_count: number; diagnostic?: string }>(`${endpoint}/test`, { method: 'POST', body: '{}' });
        if (result.status === 'sent' && !result.failed_count) setNotice(`テストメールを${result.sent_count}件送信しました。通知先の受信箱をご確認ください。`);
        else if (result.status === 'disabled') setError('メールを送信できる状態ではありません。送信設定を確認してください。');
        else setError(result.sent_count ? `${result.sent_count}件を送信し、${result.failed_count}件で失敗しました。通知先とGoogleの接続状態を確認してください。` : 'テストメールを送信できませんでした。送信元・通知先・Googleの接続状態を確認してください。');
      }
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); setConfirm(null); }
  }
  async function copyRedirect() {
    if (!settings?.redirect_uri) return;
    try { await navigator.clipboard.writeText(settings.redirect_uri); setNotice('リダイレクトURIをコピーしました。'); }
    catch { setError('コピーできませんでした。リダイレクトURI欄のURLを選択してコピーしてください。'); }
  }

  if (!owner) return <section className="admin-card admin-mail-settings"><div className="admin-card-head"><h2>メール通知</h2><Mail size={23} /></div><div className="master-settings-body"><div className="admin-alert info"><ShieldCheck size={20} />メールの設定・Google連携はオーナー権限の管理者で行ってください。</div></div></section>;
  return <section className="admin-card admin-mail-settings">
    <div className="admin-card-head"><div><h2>メール通知</h2><p className="admin-muted">注文が入ったことを、指定したメールアドレスへお知らせします。</p></div><Mail size={23} className="admin-muted" /></div>
    <div className="master-settings-body">
      <ErrorBox error={error} />{notice && <div className="admin-alert success" role="status"><CircleCheck size={18} />{notice}</div>}
      {loading ? <div className="admin-state" role="status"><LoaderCircle className="admin-spin" />メール設定を読み込んでいます…</div> : !draft || !settings ? <button className="admin-btn secondary" onClick={() => setRevision(value => value + 1)}><RefreshCw size={17} />設定を読み直す</button> : <>
        <form onSubmit={save}>
          <div className="mail-settings-section">
            <h3>通知先と送信元</h3>
            <label className="mail-settings-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span><strong>メール通知をオンにする</strong><small>設定した通知先へ、選択した注文の通知を送ります。</small></span></label>
            <div className="mail-settings-grid">
              <label className="admin-field"><FieldHelp label="送信方法" help="GmailはGoogleの送信権限でメールを送ります。Resendは既存の配信サービス設定を使います。" /><select className="admin-select" aria-label="メールの送信方法" value={draft.provider} disabled={busy} onChange={event => setDraft({ ...draft, provider: event.target.value as MailDraft['provider'] })}><option value="gmail">Gmail（Google連携）</option><option value="resend">Resend（既存の配信サービス）</option></select></label>
              {draft.provider === 'gmail' && <label className="admin-field"><FieldHelp label="送信元メールアドレス" help="Gmailで連携するGoogleアカウントのメールアドレスを入力します。別のアドレスはGmailで送信を許可したものだけ利用できます。" /><input className="admin-input" type="email" aria-label="送信元メールアドレス" value={draft.sender_email} required={draft.enabled} maxLength={254} placeholder="例：kojima.orders@gmail.com" disabled={busy} onChange={event => setDraft({ ...draft, sender_email: event.target.value })} /></label>}
            </div>
            <fieldset className="mail-recipient-fieldset"><legend><FieldHelp label="注文通知の送信先" help="注文を確認する担当者のメールアドレスを、1欄に1件入力してください。最大20件まで設定でき、Gmail以外の宛先にも送れます。" /></legend><div className="mail-recipient-list">{draft.recipients.map((recipient, index) => <div className="mail-recipient-row" key={index}><label><span className="mail-recipient-number">{index + 1}</span><input className="admin-input" type="email" aria-label={`通知先メールアドレス ${index + 1}`} value={recipient} maxLength={254} placeholder="例：tantou@example.com" disabled={busy} onChange={event => setDraft({ ...draft, recipients: draft.recipients.map((item, row) => row === index ? event.target.value : item) })} /></label><button className="admin-btn danger" type="button" aria-label={`通知先 ${index + 1} を削除`} disabled={busy} onClick={() => setDraft({ ...draft, recipients: draft.recipients.length === 1 ? [''] : draft.recipients.filter((_, row) => row !== index) })}><Trash2 size={17} /><span>削除</span></button></div>)}</div><button className="admin-btn secondary" type="button" disabled={busy || draft.recipients.length >= 20} onClick={() => setDraft({ ...draft, recipients: [...draft.recipients, ''] })}><Plus size={17} />通知先を追加</button><small className="admin-muted">最大20件。空欄の行は保存されません。</small></fieldset>
            <fieldset className="mail-events"><legend>通知するタイミング</legend>{([['notify_created', '新しい注文を受け付けたとき'], ['notify_edited', '注文内容が変更されたとき'], ['notify_cancelled', '注文がキャンセルされたとき']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={draft[key]} disabled={busy} onChange={event => setDraft({ ...draft, [key]: event.target.checked })} /><span>{label}</span></label>)}</fieldset>
          </div>
          {draft.provider === 'gmail' ? <div className="mail-settings-section">
            <h3>Googleクライアント設定</h3><p className="admin-muted">Google CloudでGmail APIを有効にし、種類が「ウェブアプリケーション」のOAuthクライアントを作成してください。</p>
            <div className="mail-settings-grid">
              <label className="admin-field mail-span-2"><FieldHelp label="GoogleクライアントID" help="Google Cloudの「APIとサービス → 認証情報」にあるOAuthクライアントIDです。末尾は apps.googleusercontent.com です。変更するとGoogleとの再連携が必要です。" /><input className="admin-input" aria-label="GoogleクライアントID" value={draft.gmail_client_id} autoComplete="off" maxLength={200} placeholder="例：123456789012-abcdef.apps.googleusercontent.com" disabled={busy} onChange={event => setDraft({ ...draft, gmail_client_id: event.target.value })} /></label>
              <label className="admin-field mail-span-2"><FieldHelp label="Googleクライアントシークレット" help="同じOAuthクライアントのシークレットを入力します。保存後は値を再表示しません。空欄で保存すると、保存済みの値を維持します。変更するとGoogleとの再連携が必要です。" /><input className="admin-input" type="password" aria-label="Googleクライアントシークレット" autoComplete="new-password" value={clientSecret} maxLength={2000} placeholder={settings.gmail_client_secret_configured ? '保存済み（変更する場合だけ入力）' : 'Google Cloudで発行した値'} disabled={busy} onChange={event => setClientSecret(event.target.value)} /><small className="admin-muted">{settings.gmail_client_secret_configured ? 'シークレットは保存済みです。' : 'シークレットは未設定です。'}</small></label>
              <label className="admin-field mail-span-2"><FieldHelp label="承認済みリダイレクトURI" help="このURLをGoogle CloudのOAuthクライアント設定にある「承認済みのリダイレクトURI」へ登録してください。末尾まで同じURLを設定します。" /><div className="mail-copy-row"><input className="admin-input" aria-label="承認済みリダイレクトURI" readOnly value={settings.redirect_uri} /><button className="admin-btn secondary" type="button" onClick={() => void copyRedirect()}><Copy size={16} />コピー</button></div></label>
            </div>
            <p className="mail-help-links"><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloudの認証情報を開く <ExternalLink size={14} /></a></p>
          </div> : <div className="admin-alert info"><Mail size={18} />{settings.resend_configured ? 'Resendに登録済みの送信元とAPIキーを使用します。' : 'Resendの送信設定が未登録です。環境のメール配信設定を行ってください。'}</div>}
          <div className="master-form-actions mail-settings-actions"><span className="admin-muted">{dirty ? '未保存の変更があります。連携・テスト前に保存してください。' : '設定は保存されています。'}</span><button className="admin-btn primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="admin-spin" /> : <Check size={17} />}メール設定を保存</button></div>
        </form>
        <div className="mail-settings-section mail-connection-section"><h3>{draft.provider === 'gmail' ? 'Googleとの連携' : '配信状態'}</h3><div className="mail-connection-status"><span className={`admin-badge ${connected ? 'active' : 'inactive'}`}>{connected ? '接続済み' : '未接続'}</span><span>{settings.enabled ? 'メール通知はオンです' : 'メール通知はオフです'}</span></div>{draft.provider === 'gmail' && <p className="admin-muted">設定を保存してからGoogleで連携し、メールの送信を許可してください。初回はGoogleの確認画面が開きます。</p>}<div className="mail-settings-button-row">{draft.provider === 'gmail' && <><button className="admin-btn primary" type="button" disabled={busy || dirty || !settings.gmail_client_id || !settings.gmail_client_secret_configured} onClick={() => void connect()}><ExternalLink size={17} />{settings.gmail_connected ? 'Googleで連携し直す' : 'Googleで連携'}</button>{settings.gmail_connected && <button className="admin-btn danger" type="button" disabled={busy || dirty} onClick={() => setConfirm('disconnect')}><Unplug size={17} />Googleとの連携を解除</button>}</>}<button className="admin-btn secondary" type="button" disabled={busy || dirty || !connected || !settings.recipients.length || (draft.provider === 'gmail' && !settings.sender_email)} onClick={() => setConfirm('test')}><Send size={17} />テストメールを送る</button></div></div>
      </>}
    </div>
    <ConfirmDialog open={!!confirm} title={confirm === 'disconnect' ? 'Googleとの連携を解除しますか？' : 'テストメールを送りますか？'} busy={busy} onClose={() => { if (!busy) setConfirm(null); }} onConfirm={() => void confirmAction()}>{confirm === 'disconnect' ? <p>メール通知をオフにし、このシステムからGmailで送信するための接続情報を削除します。再開するにはGoogleで連携し直してください。</p> : <><p>保存済みの次の通知先へ、動作確認用のメールを1通ずつ送ります。</p><ul className="mail-confirm-recipients">{settings?.recipients.map(recipient => <li key={recipient}>{recipient}</li>)}</ul></>}</ConfirmDialog>
  </section>;
}
