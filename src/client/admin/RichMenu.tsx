import { useEffect, useState } from 'react';
import { Check, CircleAlert, ExternalLink, Loader2, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './api';

type Menu = {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: { bounds: { x: number; y: number; width: number; height: number }; action: { type: string; label: string; uri: string } }[];
};
type Bot = { display_name: string; basic_id: string; picture_url?: string };
type Status = {
  configured: boolean;
  expected_basic_id: string;
  bot: Bot | null;
  default_rich_menu_id: string | null;
  default_menu_inaccessible?: boolean;
  current_menu: Menu | null;
  desired_menu: Menu | null;
  image_url: string;
};
type Installed = { rich_menu_id: string; previous_rich_menu_id: string | null; image_verified: boolean; bot: Bot; menu: Menu; already_installed: boolean };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'LINEの設定を確認できませんでした。もう一度お試しください。';
function sameMenu(current: Menu | null, desired: Menu) {
  return !!current && current.name === desired.name && current.selected === desired.selected && current.chatBarText === desired.chatBarText && JSON.stringify(current.size) === JSON.stringify(desired.size) && JSON.stringify(current.areas) === JSON.stringify(desired.areas);
}

export default function RichMenu({ owner }: { owner: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!owner) return;
    let active = true;
    setLoading(true);
    api<Status>('/api/admin/line/rich-menu').then(value => { if (active) setStatus(value); }).catch(reason => { if (active) setError(errorText(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [owner]);

  async function refresh() {
    setLoading(true); setError(''); setSuccess('');
    try { setStatus(await api<Status>('/api/admin/line/rich-menu')); }
    catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }
  async function install() {
    if (!owner || !status?.configured) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api<Installed>('/api/admin/line/rich-menu/install', { method: 'POST', body: '{}' });
      setStatus(previous => previous ? { ...previous, bot: result.bot, default_rich_menu_id: result.rich_menu_id, default_menu_inaccessible: false, current_menu: result.menu } : previous);
      setSuccess(result.already_installed ? 'このリッチメニューはすでにLINEに反映されています。' : 'リッチメニューをLINEに反映しました。LINEのトーク画面を開き直してご確認ください。');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  const applied = !!status?.default_rich_menu_id && !!status?.desired_menu && sameMenu(status.current_menu, status.desired_menu);
  return <section className="admin-card rich-menu-card">
    <div className="admin-card-head"><div><h2>LINEリッチメニュー</h2><p className="admin-muted">トーク画面から、注文やお問い合わせへ迷わず進めるように。</p></div><MessageCircle className="admin-muted" size={24} /></div>
    <div className="master-settings-body">
      {error && <div className="admin-alert master-notice master-notice-error" role="alert"><CircleAlert size={18} />{error}</div>}
      {success && <div className="admin-alert master-notice master-notice-success" role="status"><Check size={18} />{success}</div>}
      <div className="rich-menu-layout">
        <figure className="rich-menu-preview"><img src={status?.image_url || '/richmenu/kojima-richmenu.jpg'} width="2500" height="1686" alt="小島醸造のリッチメニュー。左上が注文、右上が注文履歴、左下がお問い合わせ、右下が商品紹介。" /><figcaption>LINEのトーク画面に表示するメニュー</figcaption></figure>
        <div className="rich-menu-details">
          {!owner ? <div className="rich-menu-permission"><ShieldCheck size={21} /><p>LINEへの反映は、オーナー権限の管理者でログインして行ってください。</p></div> : loading ? <div className="master-empty rich-menu-loading" role="status"><Loader2 className="master-spin" size={24} />LINEの設定を確認中…</div> : <>
            {status && <div className="rich-menu-account"><span className="master-eyebrow">LINE公式アカウント</span><strong>{status.bot?.display_name || '小島醸造'}</strong><span className="admin-muted">{status.bot?.basic_id || status.expected_basic_id}</span><span className={`admin-badge ${applied ? 'master-badge-good' : ''}`}>{applied ? 'このメニューを配信中' : status.default_menu_inaccessible ? '既存メニューは別の連携で管理中' : status.default_rich_menu_id ? '別のメニューを配信中' : 'メニュー未設定'}</span></div>}
            {status?.default_menu_inaccessible && <p className="rich-menu-note">既存のメニューは別のLINE連携で管理されています。このメニューを反映すると、標準メニューが切り替わります。</p>}
            {status && !status.configured && <p className="rich-menu-note">LINEとの連携設定が必要です。設定を完了してから、状態を更新してください。</p>}
            {!!status?.desired_menu?.areas.length && <div className="rich-menu-links"><h3>ボタンのリンク先</h3><ul>{status.desired_menu.areas.map((area, index) => <li key={area.action.label}><span className="rich-menu-position">{['左上', '右上', '左下', '右下'][index]}</span><a href={area.action.uri} target="_blank" rel="noreferrer">{area.action.label}<ExternalLink size={14} /></a></li>)}</ul></div>}
            <p className="rich-menu-note">友だち全員の標準メニューに反映します。反映後は、LINEのトーク画面を開き直してください。</p>
          </>}
        </div>
      </div>
      {owner && <div className="master-form-actions rich-menu-actions"><span className="admin-muted">変更内容は監査ログに記録されます。</span><button className="admin-btn secondary" onClick={() => void refresh()} disabled={loading || busy}><RefreshCw size={16} className={loading ? 'master-spin' : ''} />状態を更新</button><button className="admin-btn primary" onClick={() => void install()} disabled={loading || busy || !status?.configured}>{busy ? <Loader2 className="master-spin" size={17} /> : <Check size={17} />}{busy ? 'LINEに反映中…' : applied ? 'このメニューを再反映' : 'LINEに反映する'}</button></div>}
    </div>
  </section>;
}
