import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { ErrorBox, FieldHelp, Loading } from './ui';
import './reset-settings.css';

type Overview = {
  generation: number; data_revision: number; counts: Record<string, number>; active_tasks: number;
  defaults: { product_count: number; products_unavailable: boolean }; preserved: string[]; can_reset: boolean;
};
type Challenge = { token: string; expires_at: string; overview: Overview };
const endpoint = '/api/admin/reset';
const confirmationText = '初期リセット';
const completedMarker = 'kojima_reset_completed';
const countLabels = [
  ['companies', '取引先'], ['orders', '注文'], ['invoices', '請求書'], ['delivery_note_histories', '納品書の発行履歴'],
  ['line_users', 'LINE登録'], ['line_messages', 'チャット'], ['invitations', '招待QR'], ['products', '商品'], ['other_admins', 'ほかの管理者'],
] as const;

// Reset credentials and its one-use challenge only live in this component's memory.
async function request<T>(path: string, input?: object): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, { credentials: 'include', cache: 'no-store',
    ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
  });
  const body = await response.json().catch(() => ({})) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message || `通信に失敗しました（${response.status}）。画面を読み直して確認してください。`);
  return body.data as T;
}

function Counts({ overview }: { overview: Overview }) {
  return <dl className="reset-counts">{countLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{Number(overview.counts[key] || 0).toLocaleString('ja-JP')}<small>件</small></dd></div>)}</dl>;
}

export default function ResetSettings({ owner }: { owner: boolean }) {
  const [overview, setOverview] = useState<Overview | null>(null), [challenge, setChallenge] = useState<Challenge | null>(null);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(owner), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0), live = useRef(true), sending = useRef(false), review = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    live.current = true; let active = true;
    if (!owner) return () => { live.current = false; };
    try {
      if (sessionStorage.getItem(completedMarker) === '1') { sessionStorage.removeItem(completedMarker); setNotice('初期リセットが完了しました。設定と商品情報を確認し、新しい招待QRで取引先を登録してください。'); }
    } catch { /* Reset also works when browser storage is unavailable. */ }
    setLoading(true); setError('');
    request<Overview>('').then(value => { if (active) setOverview(value); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'リセット対象を読み込めませんでした。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; live.current = false; };
  }, [owner, revision]);
  useEffect(() => {
    if (!challenge) return;
    const remaining = Date.parse(challenge.expires_at) - Date.now();
    const expire = () => { setChallenge(null); setConfirmation(''); setNotice('確認の有効時間が切れました。現在のパスワードを入力し、リセット対象を確認し直してください。'); };
    if (!Number.isFinite(remaining) || remaining <= 0) { expire(); return; }
    const timeout = window.setTimeout(expire, Math.min(remaining, 2_147_483_647));
    const frame = window.requestAnimationFrame(() => {
      review.current?.focus({ preventScroll: true });
      review.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    return () => { window.clearTimeout(timeout); window.cancelAnimationFrame(frame); };
  }, [challenge]);
  function clearReview() { setChallenge(null); setConfirmation(''); setPassword(''); }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (sending.current || !password || !overview?.can_reset) return;
    sending.current = true; setBusy(true); setError(''); setNotice(''); setConfirmation('');
    try {
      const value = await request<Challenge>('/prepare', { current_password: password });
      if (!live.current) return;
      if (!value.token || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now()) throw new Error('確認の有効時間が切れました。現在のパスワードを入力し直してください。');
      setOverview(value.overview); setChallenge(value);
    } catch (error) {
      if (live.current) { clearReview(); setError(error instanceof Error ? error.message : 'リセット対象を確認できませんでした。'); }
    } finally { sending.current = false; if (live.current) { setPassword(''); setBusy(false); } }
  }
  async function execute(event: FormEvent) {
    event.preventDefault();
    if (sending.current || !challenge || confirmation !== confirmationText) return;
    if (Date.parse(challenge.expires_at) <= Date.now()) { clearReview(); setNotice('確認の有効時間が切れました。現在のパスワードを入力し直してください。'); return; }
    sending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ reset: boolean; generation: number }>('/execute', { token: challenge.token, confirmation });
      if (result?.reset !== true || !Number.isSafeInteger(result.generation)) throw new Error('リセット結果を確認できませんでした。');
      if (!live.current) return;
      clearReview();
      // Discard all admin and notification caches after a successful reset.
      try { sessionStorage.setItem(completedMarker, '1'); } catch { /* No credential is stored. */ }
      window.location.replace('/admin/settings?tab=reset');
    } catch (error) {
      if (live.current) {
        clearReview();
        setError(`${error instanceof Error ? error.message : 'リセット結果を確認できませんでした。'} 自動では再実行しません。データの状態を読み直し、必要な場合はパスワードから確認し直してください。`);
        // A timeout may have happened after the server committed. Never reuse its token.
        setOverview(null);
      }
    } finally { sending.current = false; if (live.current) setBusy(false); }
  }
  const reload = () => { clearReview(); setNotice(''); setRevision(value => value + 1); };

  return <section className="admin-card reset-settings"><div className="admin-card-head"><div><h2>初期リセット</h2><p className="admin-muted">引き渡し前に、登録データと変更した設定を初期状態へ戻します。</p></div><ShieldCheck size={24} className="admin-muted" /></div><div className="reset-settings-body">
    {!owner ? <div className="admin-alert info">初期リセットは、オーナー権限の管理者でログインして行ってください。</div> : <>
      <ErrorBox error={error} />{notice && <p className="admin-alert info" role="status">{notice}</p>}
      <div className="reset-warning" role="note"><AlertTriangle size={22} /><div><strong>削除したデータは元に戻せません。</strong><p>取引先・配送先・LINE登録・招待QR・注文・チャット・請求書・納品書・発行履歴・監査ログと、ほかの管理者を削除します。必要なデータを保存してから操作してください。</p></div></div>
      <div className="reset-scope"><div><h3>初期状態へ戻す内容</h3><p>商品は標準の11商品を「注文不可」で登録し直します。会社情報・振込先・税・注文・配送・梱包・帳票・メールの設定も初期値へ戻ります。メール連携情報と通知先は削除され、メール通知はオフになります。</p></div><div><h3>引き続き使う内容</h3><p>操作中の管理者のユーザー名・パスワードと、LINE・Cloudflareの接続設定は維持します。ほかの端末と注文者のログインは解除されます。注文の再開には、必要な設定と新しい招待QRでの登録を行ってください。</p></div></div>
      <p className="reset-external admin-muted">LINE公式アカウントの友だち・LINEアプリ内のトーク・送信済みメールは削除されません。Google側のアクセス許可も残るため、必要に応じてGoogleアカウント側で解除してください。</p>
      {loading ? <Loading /> : !overview ? <button className="admin-btn secondary" type="button" onClick={reload}><RefreshCw size={17} />リセット対象を読み直す</button> : challenge ? <form className="reset-review" onSubmit={execute}>
        <h3 ref={review} tabIndex={-1}>リセット対象の最終確認</h3><p>次のデータを削除し、設定を初期状態へ戻します。</p><Counts overview={challenge.overview} />
        <p className="admin-muted">この確認は5分間有効です。確認後にデータが変更された場合は、もう一度確認が必要です。</p>
        <label className="admin-field"><FieldHelp label="確認の文字入力" help="誤操作を防ぐため「初期リセット」とそのまま入力してください。まだリセットは実行されていません。" /><input className="admin-input" aria-label="確認の文字入力" value={confirmation} disabled={busy} required autoComplete="off" placeholder="初期リセット" onChange={event => setConfirmation(event.target.value)} /></label>
        <div className="reset-actions"><button className="admin-btn secondary" type="button" disabled={busy} onClick={() => { clearReview(); setNotice('リセットを取り消しました。データは変更していません。'); }}>取り消す</button><button className="admin-btn danger" type="submit" disabled={busy || confirmation !== confirmationText}>{busy ? <LoaderCircle size={17} className="admin-spin" /> : <Trash2 size={17} />}{busy ? 'リセット処理中…' : '確認して初期リセット'}</button></div>
      </form> : <form onSubmit={prepare} className="reset-prepare"><h3>登録されているデータ</h3><Counts overview={overview} />
        {overview.active_tasks > 0 && <p className="admin-alert info" role="status">通知などの処理が進行中です。完了後にリセット対象を読み直してください。</p>}
        <label className="admin-field"><FieldHelp label="現在のパスワード" help="操作中の管理者のログインパスワードで本人確認します。この操作だけではデータを削除しません。" /><input className="admin-input" type="password" aria-label="現在のパスワード" value={password} disabled={busy || !overview.can_reset} required maxLength={200} autoComplete="current-password" onChange={event => setPassword(event.target.value)} /></label>
        <div className="reset-actions"><button className="admin-btn secondary" type="button" disabled={busy} onClick={reload}><RefreshCw size={17} />リセット対象を読み直す</button><button className="admin-btn primary" type="submit" disabled={busy || !password || !overview.can_reset}>{busy ? <LoaderCircle size={17} className="admin-spin" /> : <KeyRound size={17} />}{busy ? '確認中…' : 'リセット対象を確認'}</button></div>
      </form>}
    </>}
  </div></section>;
}
