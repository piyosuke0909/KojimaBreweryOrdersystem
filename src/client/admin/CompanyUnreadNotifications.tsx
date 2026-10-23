import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import './company-unread-notifications.css';

type Notice = { id: string; href: string };
export type CompanyUnread = {
  company_id: string; total_unread: number; counts: { orders: number; line_messages: number };
  latest: Notice | null; latest_orders: Notice | null; latest_line_message: Notice | null;
};
const changedEvent = 'kojima-admin-notifications-changed';
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, value) : 0;

/** Fetch only the currently visible companies without changing read receipts. */
export function useCompanyUnreadNotifications(companyIds: string[]) {
  const ids = [...new Set(companyIds.filter(Boolean))].sort().join(',');
  const [entries, setEntries] = useState<Record<string, CompanyUnread>>({});
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const revision = ++sequence.current;
    controller.current?.abort();
    if (!ids) { setEntries({}); setError(''); return; }
    const request = new AbortController(); controller.current = request;
    try {
      const value = await api<{ items: CompanyUnread[] }>(`/api/admin/notifications/companies?${new URLSearchParams({ company_ids: ids })}`, { signal: request.signal });
      if (revision !== sequence.current) return;
      const allowed = new Set(ids.split(','));
      setEntries(Object.fromEntries((Array.isArray(value?.items) ? value.items : []).filter(item => allowed.has(item.company_id)).map(item => [item.company_id, {
        ...item, total_unread: count(item.total_unread), counts: { orders: count(item.counts?.orders), line_messages: count(item.counts?.line_messages) },
      }])));
      setError('');
    } catch {
      if (!request.signal.aborted && revision === sequence.current) setError('会社ごとの未読通知を取得できませんでした。');
    }
  }, [ids]);
  useEffect(() => {
    setEntries({}); setError(''); void refresh();
    const activeRefresh = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(activeRefresh, 25000);
    window.addEventListener('focus', activeRefresh); window.addEventListener(changedEvent, activeRefresh); document.addEventListener('visibilitychange', activeRefresh);
    return () => { ++sequence.current; controller.current?.abort(); window.clearInterval(timer); window.removeEventListener('focus', activeRefresh); window.removeEventListener(changedEvent, activeRefresh); document.removeEventListener('visibilitychange', activeRefresh); };
  }, [refresh]);
  return { entries, error, refresh };
}

export function CompanyUnreadLoadError({ error, refresh }: { error: string; refresh: () => Promise<void> }) {
  return error ? <p className="company-unread-load-error" role="status">{error}<button type="button" className="admin-table-detail" onClick={() => void refresh()}>通知を再読み込み</button></p> : null;
}

function destination(notice: Notice | null, companyId: string) {
  try {
    const url = new URL(notice?.href || '', window.location.origin);
    if (url.origin === window.location.origin && /^\/admin\/(companies|orders)\/[^/]+\/?$/.test(url.pathname)) return url.pathname + url.search;
  } catch { /* Fall back to the current company without opening an external link. */ }
  return `/admin/companies/${encodeURIComponent(companyId)}`;
}

/** A badge opens one exact unread event; the company itself is never bulk-read. */
export function CompanyUnreadBadge({ summary, companyName, category }: { summary?: CompanyUnread; companyName: string; category?: 'orders' | 'line_messages' }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const value = summary ? category ? summary.counts[category] : summary.total_unread : 0;
  if (!summary || !value) return null;
  const notice = category === 'orders' ? summary.latest_orders : category === 'line_messages' ? summary.latest_line_message : summary.latest;
  const label = category === 'orders' ? '注文' : category === 'line_messages' ? 'LINE' : '通知';
  const href = destination(notice, summary.company_id);
  async function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (sending.current) { event.preventDefault(); return; }
    const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0;
    if (!modified) event.preventDefault();
    if (notice?.id) {
      sending.current = true; setBusy(true);
      try {
        await api(`/api/admin/notifications/${encodeURIComponent(notice.id)}/read`, { method: 'POST', body: '{}' });
        window.dispatchEvent(new Event(changedEvent));
      } catch { /* The destination can still be opened; no other event is marked read. */ }
      finally { sending.current = false; if (mounted.current) setBusy(false); }
    }
    if (!modified && mounted.current) navigate(href);
  }
  return <a className={`company-unread-badge${busy ? ' is-busy' : ''}`} href={href} aria-label={`${companyName}の未読${label}${value}件を確認`} aria-disabled={busy || undefined} title={`LINE ${summary.counts.line_messages}件・注文 ${summary.counts.orders}件の未読`} onClick={event => void follow(event)}><span aria-hidden="true">{category ? `${label} ` : '未読 '}{value > 99 ? '99+' : value}</span></a>;
}
