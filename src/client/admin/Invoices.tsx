import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Plus, FileText, LockKeyhole, Printer, CircleCheck, RefreshCw, CalendarDays, Banknote, X } from 'lucide-react';
import { api, apiRaw, money, date } from './api';
import { Badge, Loading, Empty, ErrorBox, Modal, ConfirmDialog, Pagination, FieldHelp, useRowNavigation, navigableRowProps } from './ui';
import InvoiceDeliveryDocuments from './InvoiceDeliveryDocuments';

export default function Invoices(){const id=useLocation().pathname.split('/')[3];return id?<InvoiceDetail key={id} id={id}/>:<InvoiceList/>}
function InvoiceList(){
 const [rows,setRows]=useState<any[]>([]),[companies,setCompanies]=useState<any[]>([]),[company,setCompany]=useState(''),[status,setStatus]=useState(''),[q,setQ]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[total,setTotal]=useState(0),[busy,setBusy]=useState(true),[error,setError]=useState(''),[create,setCreate]=useState(false);const navigate=useNavigate(),rowNavigation=useRowNavigation();
 useEffect(()=>{api('/api/admin/companies?page_size=1000').then(setCompanies).catch(()=>{})},[]);
 useEffect(()=>{setBusy(true);setError('');apiRaw<any[]>(`/api/admin/invoices?company_id=${company}&status=${status}&q=${encodeURIComponent(search)}&page=${page}&page_size=20`).then(r=>{setRows(r.data);setTotal(r.meta?.total??r.data.length)}).catch(e=>setError(e.message)).finally(()=>setBusy(false))},[company,status,search,page]);
 return <><div className="admin-page-head"><div><span className="admin-eyebrow">BILLING & INVOICES</span><h1>請求管理</h1><p>お取引先ごとの請求書発行と、ご入金の状況を管理します。</p></div><button className="admin-btn primary" onClick={()=>setCreate(true)}><Plus size={18}/>請求書を作成</button></div><div className="admin-billing-notice"><span className="admin-small-icon"><FileText size={21}/></span><div><strong>発行時の内容を、いつでもそのまま。</strong><span>請求書は発行のたびに保存され、過去の版も同じ内容で印刷できます。</span></div><LockKeyhole size={19}/></div><section className="admin-card"><form className="admin-filter-bar" onSubmit={e=>{e.preventDefault();setSearch(q);setPage(1)}}><label className="admin-search"><Search size={18}/><input placeholder="請求番号・会社名で検索" value={q} onChange={e=>setQ(e.target.value)}/></label><select className="admin-select" aria-label="取引先" value={company} onChange={e=>{setCompany(e.target.value);setPage(1)}}><option value="">すべての取引先</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><select className="admin-select" aria-label="請求ステータス" value={status} onChange={e=>{setStatus(e.target.value);setPage(1)}}><option value="">すべての状態</option><option value="issued">発行済</option><option value="paid">入金済</option><option value="cancelled">取消済</option></select><button className="admin-btn primary"><Search size={17}/>検索</button></form><ErrorBox error={error}/>{busy?<Loading/>:<><div className="admin-table-wrap"><table className="admin-table admin-record-table"><thead><tr><th>請求番号</th><th>取引先</th><th>対象期間</th><th>発行日</th><th>支払期日</th><th className="num">請求金額（税込）</th><th>状態</th></tr></thead><tbody>{rows.map(v=><tr {...rowNavigation(`/admin/invoices/${v.id}`,`${v.company_name}の請求 ${v.id}`)} key={v.id}><td data-label="請求番号"><Link className="admin-order-id" to={`/admin/invoices/${v.id}`}>{v.id}</Link><small className="admin-cell-sub">第 {v.latest_version} 版</small></td><td data-label="取引先"><strong>{v.company_name}</strong></td><td data-label="対象期間">{date(v.period_start)}<small className="admin-cell-sub">〜 {date(v.period_end)}</small></td><td data-label="発行日">{date(v.issued_date)}</td><td data-label="支払期日">{date(v.due_date)}</td><td data-label="税込合計" className="num admin-tabular">{money(v.total_incl_tax)}</td><td data-label="状態"><Badge value={v.status}/></td></tr>)}</tbody></table>{!rows.length&&<Empty text="請求書はまだありません"/>}</div><Pagination page={page} total={total} onChange={setPage}/></>}</section>{create&&<CreateInvoice companies={companies} onClose={()=>setCreate(false)} onCreated={id=>navigate(`/admin/invoices/${id}`)}/>}</>
}

function CreateInvoice({companies,onClose,onCreated}:{companies:any[];onClose:()=>void;onCreated:(id:string)=>void}){
 const now=new Date(),start=new Date(now.getFullYear(),now.getMonth(),1);const local=(d:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(d);
 const [company,setCompany]=useState(''),[from,setFrom]=useState(local(start)),[to,setTo]=useState(local(now)),[due,setDue]=useState(local(new Date(now.getFullYear(),now.getMonth()+2,0))),[orders,setOrders]=useState<any[]|null>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState(false);
 async function preview(e:React.FormEvent){e.preventDefault();setError('');setBusy(true);try{const data=await api(`/api/admin/orders?company_id=${company}&from=${from}&to=${to}&page_size=1000`);const available=data.filter((o:any)=>o.status!=='cancelled'&&!o.is_invoice_locked&&o.desired_delivery_date>=from&&o.desired_delivery_date<=to);setOrders(available);setSelected(available.map((o:any)=>o.id));setConfirm(false)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function issue(){setBusy(true);setError('');try{const inv=await api('/api/admin/invoices',{method:'POST',body:JSON.stringify({company_id:company,period_start:from,period_end:to,due_date:due,order_ids:selected})});onCreated(inv.id)}catch(e){setError((e as Error).message);setConfirm(false)}finally{setBusy(false)}}
 const chosen=orders?.filter(o=>selected.includes(o.id))||[];
 return <Modal title="請求書を作成" onClose={onClose} wide><div className="admin-modal-body"><ErrorBox error={error}/><form onSubmit={preview}><div className="admin-form-grid"><label className="admin-field span-2"><FieldHelp label="取引先" help="請求書を発行するお取引先を選びます。複数企業の注文を1枚にまとめることはできません。"/><span className="admin-required">必須</span><select className="admin-select" value={company} onChange={e=>{setCompany(e.target.value);setOrders(null)}} required><option value="">取引先を選択してください</option>{companies.filter(c=>c.status==='active').map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label className="admin-field"><FieldHelp label="対象期間の開始日" help="この日から到着予定の注文を請求候補として表示します。注文日ではなく到着希望日が基準です。"/><input className="admin-input" type="date" value={from} required onChange={e=>{setFrom(e.target.value);setOrders(null)}}/></label><label className="admin-field"><FieldHelp label="対象期間の終了日" help="この日までに到着予定の未請求注文を対象にします。取消済み注文と発行済み注文は除きます。"/><input className="admin-input" type="date" min={from} value={to} required onChange={e=>{setTo(e.target.value);setOrders(null)}}/></label><label className="admin-field"><FieldHelp label="お支払期日" help="お取引先との支払条件に合わせて設定してください。請求書に表示するお振込みの期限です。"/><input className="admin-input" type="date" required value={due} onChange={e=>setDue(e.target.value)}/></label><div className="admin-field admin-align-end"><button className="admin-btn secondary" disabled={busy}><Search size={17}/>対象注文を確認する</button></div></div></form>{orders!==null&&<div className="admin-invoice-candidates"><h3>対象の注文 <span>{orders.length}件</span></h3><p className="admin-muted">対象期間に到着予定の注文から、未請求の注文を表示しています。</p>{orders.length?<><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th><input type="checkbox" aria-label="すべて選択" checked={orders.length===selected.length} onChange={e=>setSelected(e.target.checked?orders.map(o=>o.id):[])}/></th><th>注文番号</th><th>到着日</th><th className="num">注文金額（税込）</th></tr></thead><tbody>{orders.map(o=><tr {...navigableRowProps(()=>setSelected(selected.includes(o.id)?selected.filter(s=>s!==o.id):[...selected,o.id]),`${o.id}を請求対象にする`)} key={o.id}><td><input type="checkbox" aria-label={`${o.id}を請求対象にする`} checked={selected.includes(o.id)} onChange={e=>setSelected(e.target.checked?[...selected,o.id]:selected.filter(s=>s!==o.id))}/></td><td>{o.id}</td><td>{date(o.desired_delivery_date)}</td><td className="num">{money(o.total_amount)}</td></tr>)}</tbody></table></div><div className="admin-invoice-estimate"><span>{selected.length}件の注文金額合計（参考）</span><strong>{money(chosen.reduce((n,o)=>n+o.total_amount,0))}</strong></div><div className="admin-alert info"><LockKeyhole size={17}/>発行すると対象注文がロックされます。正式な請求金額は各注文に保存された税条件で確定します。</div></>:<Empty text="対象期間に請求可能な注文がありません"/>}</div>}{confirm&&<div className="admin-alert info">{selected.length}件の注文について請求書を発行します。対象取引先・期間・期日を確認してください。</div>}</div><div className="admin-modal-foot"><button className="admin-btn secondary" onClick={onClose} disabled={busy}>戻る</button><button className="admin-btn primary" disabled={busy||!selected.length||!orders} onClick={()=>confirm?issue():setConfirm(true)}><LockKeyhole size={17}/>{busy?'発行中…':confirm?'確認して請求書を発行':'請求書を発行してロックする'}</button></div></Modal>
}

function presentationRevision(history: any) {
  if (history.action_type === 'cancel') return false;
  if (history.revision_type === 'presentation') return true;
  try { return JSON.parse(history.snapshot_json || '{}').revision_type === 'presentation'; } catch { return false; }
}
function InvoiceDetail({id}:{id:string}) {
  const rowNavigation=useRowNavigation();
  const [invoice,setInvoice]=useState<any>(null),[error,setError]=useState(''),[action,setAction]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[success,setSuccess]=useState('');
  const [confirmation,setConfirmation]=useState<{expected_version:number;expected_total:number;expected_status:string}|null>(null);
  const load=()=>api(`/api/admin/invoices/${encodeURIComponent(id)}`).then(setInvoice).catch(e=>setError(e.message));
  const chooseAction=(next:string)=>{setConfirmation({expected_version:invoice.latest_version,expected_total:invoice.total_incl_tax,expected_status:invoice.status});setAction(next);};
  useEffect(()=>{void load();},[id]);
  async function execute() {
    if(!confirmation){setError('請求書の内容を読み直してから操作してください。');return;}
    if(action==='cancel'&&!reason.trim()){setError('取消理由を入力してください。');return;}
    setBusy(true);setError('');setSuccess('');
    try {
      await api(`/api/admin/invoices/${encodeURIComponent(id)}/${action}`,{method:'POST',body:JSON.stringify({...confirmation,...(action==='cancel'?{reason}:{})})});
      setSuccess(action==='pay'?'入金済みに更新しました。':action==='cancel'?'請求を取り消し、対象注文のロックを解除しました。':'請求書を再発行しました。');setAction('');setConfirmation(null);await load();
    } catch(error){setError((error as Error).message);setAction('');setConfirmation(null);await load();} finally{setBusy(false);}
  }
  if(!invoice)return <><ErrorBox error={error}/>{!error&&<Loading/>}</>;
  const history=invoice.histories||invoice.history||[];
  const reportPath=`/admin/reports/invoice/${encodeURIComponent(id)}`;
  return <>
    <Link className="admin-back-link" to="/admin/invoices"><ArrowLeft size={16}/>請求一覧へ戻る</Link>
    <div className="admin-page-head"><div><span className="admin-eyebrow">INVOICE DETAIL</span><h1>請求詳細 <span className="admin-title-id">{id}</span></h1><p>{invoice.company_name} · 第 {invoice.latest_version} 版</p></div><Badge value={invoice.status}/></div>
    <ErrorBox error={error}/>{success&&<div className="admin-alert success" role="status"><CircleCheck size={18}/>{success}</div>}
    <div className="admin-detail-layout"><div>
      <section className="admin-card"><div className="admin-card-head"><h2>請求情報</h2><Link className="admin-text-link" to={`/admin/companies/${encodeURIComponent(invoice.company_id)}`}>取引先の詳細</Link></div><div className="admin-detail-grid">
        <div><label>取引先</label><strong>{invoice.company_name}</strong></div><div><label>請求対象期間</label><strong>{date(invoice.period_start)} 〜 {date(invoice.period_end)}</strong></div>
        <div><label>発行日</label><strong>{date(invoice.issued_date)}</strong></div><div><label>支払期日</label><strong>{date(invoice.due_date)}</strong></div>
        {invoice.note&&<div className="span-2"><label>備考</label><span>{invoice.note}</span></div>}
      </div></section>
      <section className="admin-card"><div className="admin-card-head"><h2>対象の注文</h2><span className="admin-muted">{invoice.items?.length||0} 件</span></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>注文番号</th><th>注文日</th><th>到着日</th><th className="num">税抜金額</th><th className="num">消費税</th><th className="num">税込金額</th></tr></thead><tbody>
        {invoice.items?.map((item:any)=><tr {...rowNavigation(`/admin/orders/${encodeURIComponent(item.order_id)}`,`注文 ${item.order_id}の詳細`)} key={item.id}><td><Link className="admin-order-id" to={`/admin/orders/${encodeURIComponent(item.order_id)}`}>{item.order_id}</Link></td><td>{date(item.order_date)}</td><td>{date(item.delivery_date)}</td><td className="num">{money(item.amount_excl_tax)}</td><td className="num">{money(item.tax_amount)}</td><td className="num">{money(item.amount_incl_tax)}</td></tr>)}
      </tbody></table>{!invoice.items?.length&&<Empty text="対象注文はありません"/>}</div></section>
      <section className="admin-card billing-invoice-history"><div className="admin-card-head"><h2>請求書の発行履歴</h2><span className="admin-muted">過去の版も発行当時の内容で確認できます</span></div><div className="admin-table-wrap"><table className="admin-table admin-record-table"><thead><tr><th>版</th><th>操作</th><th>日時・担当者</th><th>備考</th><th>操作</th></tr></thead><tbody>
        {history.map((entry:any)=>{
          const path=`/admin/reports/invoice/${encodeURIComponent(id)}/history/${encodeURIComponent(entry.id)}`;
          const label=presentationRevision(entry)?'表示内容の修正':({issue:'新規発行',reissue:'再発行',cancel:'請求取消'} as Record<string,string>)[entry.action_type]||entry.action_type;
          return <tr {...rowNavigation(path,`第${entry.version}版の請求書をプレビュー`)} key={entry.id}>
            <td data-label="版"><strong>第 {entry.version} 版</strong></td><td data-label="内容">{label}</td>
            <td data-label="日時・担当者">{date(entry.acted_at,true)}<small className="admin-cell-sub">{entry.acted_by_name||entry.acted_by||'—'}</small></td>
            <td data-label="備考">{entry.cancel_reason||entry.note||'—'}</td><td data-label="操作"><Link className="admin-table-detail" to={path}><FileText size={15}/>プレビュー</Link></td>
          </tr>;
        })}
      </tbody></table>{!history.length&&<Empty text="発行履歴はありません"/>}</div></section>
    </div><aside className="admin-detail-side">
      <section className="admin-card"><div className="admin-card-head"><h2>請求金額</h2></div><div className="admin-totals"><div><span>税抜合計</span><strong>{money(invoice.subtotal_excl_tax)}</strong></div><div><span>消費税</span><strong>{money(invoice.tax_amount)}</strong></div><div className="admin-total-grand"><span>税込合計</span><strong>{money(invoice.total_incl_tax)}</strong></div></div></section>
      <section className="admin-card"><div className="admin-card-head"><h2>請求書の操作</h2></div><div className="admin-action-stack">
        <Link className="admin-btn primary" to={reportPath}><Printer size={17}/>プレビュー・PDF保存</Link>
        <small className="admin-muted">最新のプレビューから表示内容を修正できます。明細・税額・合計は直接変更しません。</small>
        {invoice.status==='issued'&&<button className="admin-btn secondary" disabled={busy} onClick={()=>chooseAction('pay')}><Banknote size={17}/>入金済みにする</button>}
        {invoice.status==='cancelled'?<button className="admin-btn secondary" disabled={busy} onClick={()=>chooseAction('reissue')}><RefreshCw size={17}/>請求書を再発行</button>:<button className="admin-btn danger" disabled={busy||invoice.status==='paid'} onClick={()=>{setReason('');chooseAction('cancel');}}>請求を取り消す</button>}
        <small className="admin-muted">請求を取り消すと、対象注文の編集ロックが解除されます。</small>
      </div></section>
      <InvoiceDeliveryDocuments invoiceId={id} invoiceVersion={invoice.latest_version} invoiceStatus={invoice.status}/>
    </aside></div>
    <ConfirmDialog open={!!action} title={action==='pay'?'入金済みに更新しますか？':action==='reissue'?'請求書を再発行しますか？':'請求を取り消しますか？'} busy={busy} confirmDisabled={!confirmation||(action==='cancel'&&!reason.trim())} onClose={()=>{setAction('');setConfirmation(null);}} onConfirm={()=>void execute()}>
      {action==='cancel'?<><p>対象注文の請求ロックを解除します。発行済みの帳票は履歴に残ります。</p><label className="admin-field"><FieldHelp label="取消理由（必須）" help="請求を取り消す理由を入力します。過去の請求書は履歴に残り、対象注文の請求ロックだけを解除します。"/><textarea className="admin-input" placeholder="例：数量変更による再発行のため" rows={3} value={reason} onChange={event=>setReason(event.target.value)}/></label></>:<p>{action==='pay'?`${invoice.company_name}からのご入金 ${money(confirmation?.expected_total??invoice.total_incl_tax)}（第${confirmation?.expected_version??invoice.latest_version}版）を確認してください。`:'最新の注文内容で新しい版を発行し、対象注文を再びロックします。過去の版は履歴に残ります。'}</p>}
    </ConfirmDialog>
  </>;
}
