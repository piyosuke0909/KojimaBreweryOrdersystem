import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Printer, RefreshCw } from 'lucide-react';
import { api, date } from './api';
import { ConfirmDialog, ErrorBox } from './ui';
import './billing-documents.css';

type Row = Record<string, any>;
type DeliveryNotes = { items: Row[]; orders: Row[]; invoice_id: string; invoice_version: number; can_issue: boolean };
type IssueRequest = { request_id: string; version: number; invoice_id: string; invoice_version: number };
export default function InvoiceDeliveryDocuments({ invoiceId, invoiceVersion, invoiceStatus }: { invoiceId: string; invoiceVersion: number; invoiceStatus: string }) {
  const [data, setData] = useState<DeliveryNotes | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState('');
  const [selected, setSelected] = useState(''), [confirm, setConfirm] = useState(false), [pending, setPending] = useState<{ orderId: string; body: IssueRequest } | null>(null), [failed, setFailed] = useState(false), [reload, setReload] = useState(0);
  const generation = useRef(0), sending = useRef(false);
  const endpoint = `/api/admin/invoices/${encodeURIComponent(invoiceId)}/delivery-notes`;
  useEffect(() => {
    const expected = ++generation.current;
    setLoading(true); setError(''); setSuccess(''); setData(null); setSelected(''); setPending(null); setConfirm(false); setFailed(false);
    void api<DeliveryNotes>(endpoint).then(value => {
      if (generation.current !== expected) return;
      const normalized = { ...value, items: Array.isArray(value.items) ? value.items : [], orders: Array.isArray(value.orders) ? value.orders : [] };
      setData(normalized); setSelected(normalized.orders.find(order => order.status !== 'cancelled')?.id || normalized.orders[0]?.id || '');
    }).catch(error => { if (generation.current === expected) setError(error instanceof Error ? error.message : '納品書を読み込めませんでした。'); }).finally(() => { if (generation.current === expected) setLoading(false); });
    return () => { ++generation.current; };
  }, [endpoint, invoiceVersion, reload]);
  const order = data?.orders.find(value => value.id === selected);
  const canIssue = !!data?.can_issue && invoiceStatus !== 'cancelled' && !!order && order.status !== 'cancelled' && Number.isInteger(order.version) && data.invoice_version === invoiceVersion;
  function prepare() {
    if (!order || !canIssue || sending.current) return;
    if (!pending) setPending({ orderId: order.id, body: { request_id: crypto.randomUUID(), version: order.version, invoice_id: invoiceId, invoice_version: data!.invoice_version } });
    setConfirm(true); setError('');
  }
  async function issue() {
    if (!pending || sending.current) return;
    sending.current = true; setBusy(true); setError(''); setSuccess(''); const expected = generation.current;
    try {
      const result = await api<Row>(`/api/admin/orders/${encodeURIComponent(pending.orderId)}/delivery-notes`, { method: 'POST', body: JSON.stringify(pending.body) });
      if (generation.current !== expected) return;
      if (!result.id) throw new Error('発行した納品書を確認できませんでした。発行履歴を読み直してください。');
      setConfirm(false); setPending(null); setFailed(false);
      setData(current => current ? { ...current, items: [result, ...current.items.filter(item => item.id !== result.id)] } : current);
      setSuccess(`注文 ${pending.orderId} の納品書を第${result.version}版として発行しました。発行履歴からプレビューできます。`);
    } catch (error) {
      if (generation.current !== expected) return;
      setError(error instanceof Error ? error.message : '納品書の発行結果を確認できませんでした。'); setFailed(true); setConfirm(false);
    } finally { sending.current = false; if (generation.current === expected) setBusy(false); }
  }
  const isStale = !!data && data.invoice_version !== invoiceVersion;
  return <>
    <section className="admin-card billing-delivery-actions" aria-label="納品書の操作">
      <div className="admin-card-head"><h2>納品書の操作</h2></div>
      <div className="admin-action-stack">
        <ErrorBox error={error} />
        {success && <p className="admin-alert success" role="status">{success}</p>}
        {loading ? <p role="status" className="admin-muted">納品書を読み込み中…</p> : data && <>
          <label className="admin-field"><span>納品書の対象注文</span><select className="admin-select" value={selected} disabled={busy || failed} onChange={event => { setSelected(event.target.value); setPending(null); setError(''); }}>
            {!data.orders.length && <option value="">対象注文はありません</option>}
            {data.orders.map(value => <option key={value.id} value={value.id}>{value.id} · {date(value.desired_delivery_date)}{value.status === 'cancelled' ? '（キャンセル済）' : ''}</option>)}
          </select></label>
          {order && canIssue && <Link className="admin-btn secondary" to={`/admin/reports/order/${encodeURIComponent(order.id)}?${new URLSearchParams({invoice_id:invoiceId})}`}><FileText size={17} />納品書をプレビュー</Link>}
          <button type="button" className="admin-btn primary" disabled={!canIssue || busy} onClick={prepare}><Printer size={17} />納品書を発行</button>
          <small className="admin-muted">発行すると、その時点の明細・金額・発行元を履歴に保存します。プレビューだけでは発行しません。</small>
          {invoiceStatus === 'cancelled' && <p className="admin-muted">取消済みの請求書から新しく納品書は発行できません。保存済みの履歴は確認できます。</p>}
          {isStale && <p className="admin-muted">請求書が更新されています。請求詳細を再読み込みしてから発行してください。</p>}
        </>}
        {failed && <p className="admin-muted" role="status">同じ対象注文・送信番号で再試行できます。履歴を読み直して、発行済みか確認することもできます。</p>}
        {(error || failed) && <button type="button" className="admin-btn secondary" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={17} />納品書の履歴を読み直す</button>}
      </div>
    </section>
    <section className="admin-card billing-delivery-history" aria-label="納品書の発行履歴">
      <div className="admin-card-head"><h2>納品書の発行履歴</h2></div>
      <div className="billing-delivery-history-body">
        <p className="admin-muted">保存した発行時の内容を、同じ版で確認できます。</p>
        {!!data?.items.length && <table className="billing-delivery-history-table"><thead><tr><th>注文・版</th><th>発行日時・担当者</th><th>操作</th></tr></thead><tbody>{data.items.map(history => <tr key={history.id}>
          <td><strong>{history.order_id}</strong><span>第 {history.version} 版</span></td>
          <td><time>{date(history.issued_at, true)}</time><span>{history.issued_by_name || history.issued_by || '—'}</span></td>
          <td><Link className="admin-btn secondary" to={`/admin/reports/order/${encodeURIComponent(history.order_id)}/history/${encodeURIComponent(history.id)}`}><FileText size={16} />プレビュー</Link></td>
        </tr>)}</tbody></table>}
        {!loading && !error && !data?.items.length && <p className="admin-muted">発行履歴はありません。</p>}
      </div>
    </section>
    <ConfirmDialog open={confirm} title="納品書を発行しますか？" busy={busy} onClose={() => { if (!busy) setConfirm(false); }} onConfirm={() => void issue()}>
      <p>注文 {pending?.orderId} の納品書を履歴へ保存します。明細・計算結果・注文の状態は変更しません。</p>
      <p>発行元の会社情報と対象注文が正しいことを確認してください。</p>
    </ConfirmDialog>
  </>;
}
