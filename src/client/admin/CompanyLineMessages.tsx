import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LoaderCircle, MessageCircle, RefreshCw, Send } from 'lucide-react';
import { api, date } from './api';
import { ConfirmDialog, Empty, ErrorBox } from './ui';
import './company-line-messages.css';

type Message = {
  id: string; line_user_id: string; direction: 'incoming' | 'outgoing'; text: string;
  status: 'received' | 'pending' | 'sent' | 'failed' | 'unknown'; created_at: string;
  sent_at?: string | null; error_code?: string | null; can_retry: boolean; request_id?: string | null; sequence?: number;
};
type Contact = { id: string; staff_name: string; line_display_name?: string | null; status: string; unread_count: number; registered_at?: string | null };
type Inbox = { contacts: Contact[]; send_enabled: boolean };
type ThreadPage = { messages: Message[]; next_cursor: string | null };
type Thread = ThreadPage & { contactId: string };
type Intent = { contactId: string; text: string; requestId: string; retry?: true };
const statusLabels: Record<Message['status'], string> = { received: '受信', pending: '送信処理中', sent: '送信済', failed: '送信失敗', unknown: '送信結果を確認できません' };
const contactName = (contact?: Contact) => contact?.staff_name || contact?.line_display_name || '登録済み担当者';
const contactLabel = (contact?: Contact) => `${contactName(contact)}${contact?.registered_at && Number.isFinite(Date.parse(contact.registered_at)) ? `（登録 ${date(contact.registered_at, true)}）` : ''}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : '通信に失敗しました。もう一度お試しください。';
const merge = (old: Message[], fresh: Message[]) => [...new Map([...old, ...fresh].map(message => [message.id, message])).values()].sort((a, b) => Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence) ? a.sequence! - b.sequence! : a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
const notificationChanged = () => window.dispatchEvent(new Event('kojima-admin-notifications-changed'));

export default function CompanyLineMessages({ companyId, companyName, companyActive }: { companyId: string; companyName: string; companyActive: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const endpoint = `/api/admin/companies/${encodeURIComponent(companyId)}/line-messages`;
  const requestedContact = new URLSearchParams(location.search).get('line_user_id') || '';
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [selected, setSelected] = useState(requestedContact);
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState('');
  const [sendError, setSendError] = useState('');
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [uncertain, setUncertain] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const inboxSequence = useRef(0);
  const readIds = useRef(new Set<string>());
  const threadRevision = useRef(0);
  const messageRevisions = useRef(new Map<string, number>());
  const cursorRevision = useRef<number | null>(null);
  const contact = inbox?.contacts.find(value => value.id === selected);
  const messages = thread?.contactId === selected ? thread.messages : [];
  const sendEnabled = !!inbox?.send_enabled && companyActive && contact?.status === 'active';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++inboxSequence.current; };
  }, [endpoint]);

  const loadInbox = useCallback(async () => {
    const request = ++inboxSequence.current;
    const value = await api<Inbox>(endpoint);
    if (mounted.current && request === inboxSequence.current) setInbox(value);
    return value;
  }, [endpoint]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    loadInbox().then(value => {
      if (!active) return;
      if (requestedContact && !value.contacts.some(item => item.id === requestedContact)) {
        setSelected(''); setError('このLINE担当者は表示できません。担当者を選び直してください。');
      } else setSelected(requestedContact || value.contacts[0]?.id || '');
    }).catch(error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadInbox, requestedContact]);

  const refreshThread = useCallback(async (contactId: string, expected: number, before?: string) => {
    const revision = ++threadRevision.current;
    const value = await api<ThreadPage>(`${endpoint}/${encodeURIComponent(contactId)}?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (!mounted.current || expected !== generation.current) return;
    // Polling, manual refresh and history pagination can finish out of order.
    // Retain previously unseen history while rejecting older copies of a
    // message that a newer response (or a completed send) already updated.
    const fresh = value.messages.filter(message => {
      if ((messageRevisions.current.get(message.id) ?? -1) > revision) return false;
      messageRevisions.current.set(message.id, revision);
      return true;
    });
    // Establish the cursor once, then advance it only with history requests.
    // Latest-page polling must not rewind a conversation already paged back.
    const updateCursor = cursorRevision.current === null || !!before && revision > cursorRevision.current;
    if (updateCursor) cursorRevision.current = revision;
    setThread(current => ({
      contactId,
      messages: merge(current?.contactId === contactId ? current.messages : [], fresh),
      next_cursor: updateCursor ? value.next_cursor : current?.contactId === contactId ? current.next_cursor : null,
    }));
  }, [endpoint]);

  useEffect(() => {
    const expected = ++generation.current;
    setThread(null); setDraft(''); setIntent(null); setUncertain(null); setSendError(''); setNotice(''); setOlderLoading(false);
    readIds.current = new Set();
    messageRevisions.current = new Map(); cursorRevision.current = null;
    if (!selected) return;
    setLoading(true);
    refreshThread(selected, expected).catch(error => { if (generation.current === expected) setError(errorText(error)); }).finally(() => { if (generation.current === expected) setLoading(false); });
    const refresh = () => {
      if (document.hidden) return;
      void Promise.all([refreshThread(selected, expected), loadInbox()]).catch(error => { if (generation.current === expected) setError(errorText(error)); });
    };
    const timer = window.setInterval(refresh, 20000);
    const visible = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    return () => { ++generation.current; window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [selected, refreshThread, loadInbox]);

  useEffect(() => {
    if (!selected || thread?.contactId !== selected || document.hidden) return;
    const expected = generation.current;
    const seen = readIds.current;
    const ids = thread.messages.filter(message => message.direction === 'incoming' && !readIds.current.has(message.id)).map(message => message.id);
    if (!ids.length) return;
    // Acknowledge only messages loaded into this conversation, never unseen
    // arrivals or another contact's unread notifications.
    ids.forEach(id => seen.add(id));
    void (async () => {
      try {
        let changed = false;
        // A later refresh can clean up this effect while an acknowledgement is
        // in flight. Finish every already-visible batch rather than dropping
        // unsubmitted IDs that were reserved in the deduplication set.
        for (let offset = 0; offset < ids.length; offset += 100) {
          const result = await api<{ read: boolean; read_count: number }>(`${endpoint}/${encodeURIComponent(selected)}/read`, { method: 'POST', body: JSON.stringify({ message_ids: ids.slice(offset, offset + 100) }) });
          changed ||= result.read_count > 0;
        }
        if (changed) notificationChanged();
        if (mounted.current && expected === generation.current && changed) void loadInbox().catch(() => {});
      } catch { ids.forEach(id => seen.delete(id)); }
    })();
  }, [selected, thread, endpoint, loadInbox]);

  useEffect(() => {
    if (!uncertain || thread?.contactId !== uncertain.contactId) return;
    const found = thread.messages.find(message => message.request_id === uncertain.requestId);
    if (found) { setUncertain(null); setDraft(''); setSendError(''); }
  }, [thread, uncertain]);

  function chooseContact(id: string) {
    if (busy || uncertain) return;
    setSelected(id); setError('');
    const params = new URLSearchParams(location.search);
    params.set('tab', 'line-messages'); params.set('line_user_id', id);
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }
  async function send(value: Intent) {
    if (inFlight.current || !sendEnabled || selected !== value.contactId) return;
    inFlight.current = true; setBusy(true); setSendError(''); setNotice('');
    const expected = generation.current;
    try {
      const message = await api<Message>(`${endpoint}/${encodeURIComponent(value.contactId)}`, { method: 'POST', body: JSON.stringify({ text: value.text, request_id: value.requestId, ...(value.retry ? { retry: true } : {}) }) });
      if (!mounted.current || expected !== generation.current) return;
      messageRevisions.current.set(message.id, ++threadRevision.current);
      setThread(current => ({ contactId: value.contactId, messages: merge(current?.contactId === value.contactId ? current.messages : [], [message]), next_cursor: current?.contactId === value.contactId ? current.next_cursor : null }));
      setDraft(''); setUncertain(null); setIntent(null);
      setNotice(message.status === 'sent' ? 'LINEがメッセージの送信を受け付けました。' : message.status === 'pending' ? '送信処理中です。履歴で結果をご確認ください。' : '送信を確認できませんでした。メッセージの状態をご確認ください。');
      void loadInbox().catch(() => {});
    } catch (error) {
      if (!mounted.current || expected !== generation.current) return;
      setSendError(errorText(error)); setUncertain({ ...value, retry: undefined }); setIntent(null);
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function older() {
    if (!selected || !thread?.next_cursor || olderLoading) return;
    setOlderLoading(true); setError('');
    const expected = generation.current;
    try { await refreshThread(selected, expected, thread.next_cursor); }
    catch (error) { if (generation.current === expected) setError(errorText(error)); } finally { if (generation.current === expected) setOlderLoading(false); }
  }
  async function refresh() {
    setError('');
    const expected = generation.current;
    try { await loadInbox(); if (selected && expected === generation.current) await refreshThread(selected, expected); }
    catch (error) { if (mounted.current && expected === generation.current) setError(errorText(error)); }
  }

  return <section className="admin-card company-line-messages">
    <div className="admin-card-head"><div><h2>LINEメッセージ</h2><p className="admin-muted">登録済みの担当者とのメッセージを確認・送信します。</p></div><button type="button" className="admin-btn secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={17} />更新</button></div>
    <div className="company-line-body">
      <ErrorBox error={error} />
      {inbox && !inbox.send_enabled && <div className="admin-alert info"><MessageCircle size={18} />この環境ではLINEの実送信を利用できません。受信履歴は確認できます。</div>}
      {!companyActive && <div className="admin-alert info">この取引先は利用停止中のため、メッセージを送信できません。</div>}
      {inbox?.contacts.length ? <>
        <label className="admin-field"><span>LINEの担当者</span><select className="admin-select" aria-label="LINEの担当者" disabled={busy || !!uncertain} value={selected} onChange={event => chooseContact(event.target.value)}>{!selected && <option value="">担当者を選択してください</option>}{inbox.contacts.map(value => <option key={value.id} value={value.id}>{contactLabel(value)}{value.status !== 'active' ? '（利用停止）' : ''}{value.unread_count ? `・未読${value.unread_count}件` : ''}</option>)}</select></label>
        {selected && <>
          <div className="company-line-thread" aria-label={`${contactName(contact)}とのLINEメッセージ`}>
            {thread?.next_cursor && <button type="button" className="admin-btn secondary company-line-older" disabled={olderLoading} onClick={() => void older()}>{olderLoading ? <LoaderCircle size={17} className="admin-spin" /> : null}以前のメッセージを表示</button>}
            {loading && !thread ? <div className="admin-state" role="status"><LoaderCircle size={24} className="admin-spin" />メッセージを読み込んでいます…</div> : messages.length ? <ol className="company-line-message-list">{messages.map(message => <li key={message.id} className={`company-line-message ${message.direction}`}><div className="company-line-message-heading"><strong>{message.direction === 'incoming' ? contactName(contact) : '小島醸造'}</strong><span className={`company-line-status ${message.status}`}>{statusLabels[message.status]}</span></div><p>{message.text}</p><time dateTime={message.sent_at || message.created_at}>{date(message.sent_at || message.created_at, true)}</time>{['failed', 'unknown'].includes(message.status) && <div className="company-line-send-note">{message.status === 'unknown' ? '送信できた可能性があります。履歴とLINEのトークをご確認ください。' : '送信できませんでした。友だち追加・ブロック解除や接続設定をご確認ください。'}</div>}{message.can_retry && message.request_id && <button type="button" className="admin-btn secondary" disabled={!sendEnabled || busy || !!uncertain} onClick={() => setIntent({ contactId: selected, text: message.text, requestId: message.request_id!, retry: true })}>同じメッセージを再送</button>}</li>)}</ol> : <Empty text="この担当者とのメッセージはまだありません" />}
          </div>
          {contact?.status !== 'active' && <div className="admin-alert info">この担当者は紐付け解除済みのため、メッセージを送信できません。</div>}
          <form className="company-line-compose" onSubmit={event => { event.preventDefault(); if (sendEnabled && draft.trim() && !busy && !uncertain) setIntent({ contactId: selected, text: draft.trim(), requestId: crypto.randomUUID() }); }}>
            <label className="admin-field"><span>メッセージ</span><textarea className="admin-input" aria-label="メッセージ" rows={4} maxLength={5000} value={draft} disabled={!sendEnabled || busy || !!uncertain} placeholder="例：ご注文ありがとうございます。お届け日は11月5日の予定です。" onChange={event => setDraft(event.target.value)} /></label>
            <div className="company-line-compose-footer"><small className="admin-muted">{draft.length.toLocaleString('ja-JP')} / 5,000文字</small><button type="submit" className="admin-btn primary" disabled={!sendEnabled || !draft.trim() || busy || !!uncertain}><Send size={17} />送信内容を確認</button></div>
            <ErrorBox error={sendError} />
            {uncertain && <div className="admin-alert info company-line-uncertain"><p>送信結果が不明なため、新しい送信を止めています。同じ送信の状態を確認してください。</p><button type="button" className="admin-btn secondary" disabled={busy || !sendEnabled} onClick={() => void send(uncertain)}>送信状況を確認</button></div>}
            {notice && <div className="admin-alert info" role="status">{notice}</div>}
          </form>
        </>}
      </> : loading ? <div className="admin-state" role="status"><LoaderCircle className="admin-spin" />LINE利用者を確認しています…</div> : <Empty text="LINE利用者が登録されていません" />}
    </div>
    <ConfirmDialog open={!!intent} title="LINEメッセージを送信しますか？" busy={busy} confirmDisabled={!sendEnabled} onClose={() => { if (!busy) setIntent(null); }} onConfirm={() => { if (intent) void send(intent); }}><p><strong>{companyName} / {contactLabel(inbox?.contacts.find(value => value.id === intent?.contactId))}</strong>へ、次の内容をLINEで送信します。</p><div className="company-line-confirm-text">{intent?.text}</div>{intent?.retry && <p className="admin-muted">以前の送信と同じ識別子で再試行します。送信済みの場合は重複送信しません。</p>}</ConfirmDialog>
  </section>;
}
