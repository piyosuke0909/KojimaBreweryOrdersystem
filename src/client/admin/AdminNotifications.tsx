import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { Bell, CheckCheck, LoaderCircle, RefreshCw } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, date } from './api';
import './admin-notifications.css';

type Category = 'orders' | 'companies';
type Notification = { id: string; kind: string; category: Category; title: string; href: string; created_at: string; is_read: boolean };
type Snapshot = { items: Notification[]; total_unread: number; counts: Record<Category, number> };
const empty = (): Snapshot => ({ items: [], total_unread: 0, counts: { orders: 0, companies: 0 } });
const changeEvent = 'kojima-admin-notifications-changed';
const endpoint = '/api/admin/notifications';
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const badgeText = (value: number) => value > 99 ? '99+' : String(value);
function snapshot(value: any): Snapshot {
  return { items: Array.isArray(value?.items) ? value.items.filter((item: any) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.href === 'string').slice(0, 5) : [], total_unread: count(value?.total_unread), counts: { orders: count(value?.counts?.orders), companies: count(value?.counts?.companies) } };
}
function safeDestination(item: Notification) {
  try {
    const url = new URL(item.href, window.location.origin);
    if (url.origin === window.location.origin && /^\/admin\/(orders|companies)\/[^/]+\/?$/.test(url.pathname)) return url.pathname + url.search;
  } catch { /* A malformed destination never navigates outside the admin portal. */ }
  return item.category === 'orders' ? '/admin/orders' : '/admin/companies';
}

/** Each administrator reads their own server-backed notification state. */
export function useAdminNotifications(adminId: string | null) {
  const [data, setData] = useState<Snapshot>(empty);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const currentAdmin = useRef(adminId);
  currentAdmin.current = adminId;
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const previousUnread = useRef<number | null>(null);
  const apply = useCallback((value: unknown) => {
    const next = snapshot(value);
    const previous = previousUnread.current;
    if (previous !== null && next.total_unread > previous) setAnnouncement(`新しい通知が${next.total_unread - previous}件あります。未読は${next.total_unread}件です。`);
    previousUnread.current = next.total_unread;
    setData(next);
  }, []);
  const refresh = useCallback(async () => {
    if (!adminId || currentAdmin.current !== adminId || mutating.current) return;
    const revision = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true);
    try {
      const result = await api<Snapshot>(endpoint, { signal: request.signal });
      if (revision !== sequence.current || currentAdmin.current !== adminId) return;
      apply(result); setError('');
    } catch (error) {
      if (!request.signal.aborted && revision === sequence.current && currentAdmin.current === adminId) setError('通知を読み込めませんでした。もう一度お試しください。');
    } finally {
      if (revision === sequence.current && currentAdmin.current === adminId) setLoading(false);
    }
  }, [adminId, apply]);
  useEffect(() => {
    ++sequence.current; controller.current?.abort();
    previousUnread.current = null; setData(empty()); setError(''); setAnnouncement(''); setLoading(false); setBusy(false); mutating.current = false;
    if (!adminId) return;
    void refresh();
    const activeRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(activeRefresh, 25000);
    window.addEventListener('focus', activeRefresh);
    window.addEventListener(changeEvent, activeRefresh);
    document.addEventListener('visibilitychange', activeRefresh);
    return () => {
      ++sequence.current; controller.current?.abort(); window.clearInterval(timer);
      window.removeEventListener('focus', activeRefresh); window.removeEventListener(changeEvent, activeRefresh); document.removeEventListener('visibilitychange', activeRefresh);
    };
  }, [adminId, refresh]);
  const mark = useCallback(async (id?: string) => {
    if (!adminId || mutating.current || currentAdmin.current !== adminId) return false;
    mutating.current = true; setBusy(true); setError(''); const revision = ++sequence.current; controller.current?.abort(); setLoading(false);
    try {
      const result = await api<Snapshot>(id ? `${endpoint}/${encodeURIComponent(id)}/read` : `${endpoint}/read-all`, { method: 'POST', body: '{}' });
      if (currentAdmin.current !== adminId || revision !== sequence.current) return false;
      apply(result); return true;
    } catch {
      if (currentAdmin.current === adminId && revision === sequence.current) setError('既読の保存ができませんでした。もう一度お試しください。');
      return false;
    } finally {
      if (currentAdmin.current === adminId && revision === sequence.current) { mutating.current = false; setBusy(false); }
    }
  }, [adminId, apply]);
  return { ...data, loading, busy, error, announcement, refresh, mark };
}
type Notifications = ReturnType<typeof useAdminNotifications>;

export function SidebarNotificationBadge({ category, label, value }: { category: Category; label: string; value: number }) {
  if (!value) return null;
  return <><sup className="admin-notification-nav-badge" aria-hidden="true">{badgeText(value)}</sup><span id={`admin-unread-${category}`} className="admin-notification-sr-only">{label}の未読{value}件</span></>;
}

export function AdminNotificationBell({ notifications }: { notifications: Notifications }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { setOpen(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.MouseEvent | FocusEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  async function follow(event: MouseEvent<HTMLAnchorElement>, item: Notification) {
    if (notifications.busy) { event.preventDefault(); return; }
    const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0;
    if (modified) { if (!item.is_read) void notifications.mark(item.id); return; }
    event.preventDefault();
    if (!item.is_read) await notifications.mark(item.id);
    setOpen(false); navigate(safeDestination(item));
  }
  return <div className="admin-notification-wrapper" ref={wrapper}>
    <button type="button" ref={button} className="admin-notification-bell" aria-label={notifications.total_unread ? `通知（未読${notifications.total_unread}件）` : '通知'} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} title="新着通知" onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); window.setTimeout(() => panel.current?.querySelector<HTMLElement>('a,button:not(:disabled)')?.focus(), 0); }
    }}><Bell size={23} aria-hidden="true" />{notifications.total_unread > 0 && <sup className="admin-notification-bell-badge" aria-hidden="true">{badgeText(notifications.total_unread)}</sup>}</button>
    <span className="admin-notification-sr-only" aria-live="polite" aria-atomic="true">{notifications.announcement}</span>
    {open && <div id={id} ref={panel} className="admin-notification-panel" role="dialog" aria-label="新着通知">
      <div className="admin-notification-heading"><div><h2>新着通知</h2><p>最新5件 · 未読{notifications.total_unread}件</p></div><button type="button" className="admin-notification-mark-all" disabled={!notifications.total_unread || notifications.busy} onClick={() => void notifications.mark()}><CheckCheck size={16} />すべて既読</button></div>
      {notifications.error && <div className="admin-notification-error" role="alert"><p>{notifications.error}</p><button type="button" disabled={notifications.loading || notifications.busy} onClick={() => void notifications.refresh()}><RefreshCw size={15} />再読み込み</button></div>}
      {!notifications.items.length && !notifications.error && <p className="admin-notification-empty">{notifications.loading ? <><LoaderCircle size={18} className="admin-spin" />通知を読み込んでいます…</> : '新しい通知はありません。'}</p>}
      <ul className="admin-notification-list">{notifications.items.map(item => <li key={item.id}><a href={safeDestination(item)} className={item.is_read ? '' : 'is-unread'} onClick={event => void follow(event, item)} aria-disabled={notifications.busy || undefined}><span className={`admin-notification-dot ${item.is_read ? 'is-read' : ''}`} aria-hidden="true" /><span className="admin-notification-content"><strong>{item.title}</strong><small><span>{item.category === 'companies' ? 'LINEメッセージ' : '注文'}</span><time dateTime={item.created_at}>{date(item.created_at, true)}</time>{!item.is_read && <em>未読</em>}</small></span></a></li>)}</ul>
    </div>}
  </div>;
}
