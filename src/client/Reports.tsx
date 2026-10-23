import { useEffect,useRef,useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Printer, AlertCircle, Pencil, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import './reports.css';
import { ConfirmDialog } from './admin/ui';
import { InvoicePresentationEditor, applyInvoicePresentation, invoicePresentation, presentationWarning, type InvoicePresentation } from './admin/InvoicePresentationEditor';
type Row=Record<string,any>;
type Document={title:string;number:string;date:string;recipient:string;address:string;issuer:Row;report:Row;rows:string[][];subtotal:number;shipping:number;tax:number;total:number;note:string;bank:string;amountLabel?:string;draft?:boolean;version?:number;due?:string;qr?:string;invitation?:boolean;referenceTax?:boolean};
const yen=(n:number)=>`${Number(n??0).toLocaleString('ja-JP')}円`;
function normalize(data:Row):Document {
  const invoice=data.kind==='invoice',order=data.order??{},bill=data.invoice??{},report=data.report_settings??{},issuer=data.issuer??{};
  const shipping=invoice?(data.orders??[]).reduce((sum:number,o:Row)=>sum+Number(o.shipping_fee??0),0):Number(order.shipping_fee??0);
  const itemRows=(items:Row[])=>items.map((r:Row)=>[r.snap_product_name||r.product_name||'',`${r.snap_volume_ml??''}ml`,`${r.quantity} ${r.snap_unit||'本'}`,yen(r.unit_price),yen(r.subtotal)]);
  const rows=invoice&&data.orders?.length?data.orders.flatMap((o:Row)=>[[`${o.desired_delivery_date}　${o.id}`,'','','',''],...itemRows(o.items??[])]):itemRows(data.items??order.items??[]);
  return {title:invoice?(report.invoice_title||'御請求書'):(report.delivery_note_title||'納品書'),number:invoice?bill.id:order.id,date:invoice?bill.issued_date:(data.issued_date||(data.issued_at?new Date(data.issued_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}):new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}))),recipient:invoice?data.company?.name:order.company_name||order.snap_recipient_name,address:invoice?data.company?.address||'':`${order.snap_postal_code||''} ${order.snap_address||''}`,issuer,report,
    rows,
    subtotal:invoice?Number(data.subtotal_excl_tax)-shipping:order.items_subtotal,shipping,tax:invoice?data.tax_amount:order.tax_amount,total:invoice?data.total_incl_tax:order.total_amount,
    note:invoice?(bill.note??report.invoice_note_template??''):(order.note??report.delivery_note_template??''),
    bank:invoice&&issuer.bank_name?`${issuer.bank_name} ${issuer.bank_branch_name||''} ${issuer.bank_account_type||''} ${issuer.bank_account_number||''}\n${issuer.bank_account_holder||''}`:'',version:data.version,due:bill.due_date,
    amountLabel:invoice?'ご請求金額':'合計金額',draft:data.is_draft===true,referenceTax:!invoice&&order.snap_tax_calc_unit==='invoice'};
}
async function pdfDocument(document:Document) {
  const [{PDFDocument,rgb},fontkit]=await Promise.all([import('pdf-lib'),import('@pdf-lib/fontkit')]);
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit.default);
  const response=await fetch('/fonts/NotoSansJP-Regular.ttf');if(!response.ok)throw new Error('日本語フォントを読み込めませんでした。');
  // This font's subset stream loses glyphs in PDF renderers. Embed its decoded SFNT in full.
  const font=await pdf.embedFont(await response.arrayBuffer(),{subset:false});
  let page=pdf.addPage([595.28,841.89]),y=790;const left=46;
  const draw=(value:string,x=left,size=10)=>{
    for(const source of String(value??'').split('\n')){
      const chunks=source.match(/.{1,43}/gu)||[''];
      for(const chunk of chunks){if(y<58){page=pdf.addPage([595.28,841.89]);y=790;}page.drawText(chunk,{x,y,size,font,color:rgb(.08,.14,.22)});y-=size+9;}
    }
  };
  if(document.draft)draw('未発行のプレビュー',left,10);
  draw(document.title,left,24);draw(`発行日 ${document.date}　${document.number} ${document.version?`第${document.version}版`:''}`);
  y-=10;draw(`${document.recipient} 御中`,left,16);draw(document.address);
  if(document.report.show_issuer_info!==0){draw(document.issuer.display_name||document.issuer.company_name||'小島醸造');draw(`${document.issuer.postal_code||''} ${document.issuer.address||''}`);draw(`TEL ${document.issuer.tel||'未登録'}`);
    if(document.report.show_invoice_reg_no!==0&&document.issuer.invoice_reg_no)draw(`登録番号 ${document.issuer.invoice_reg_no}`);
    if(document.report.show_contact_person!==0&&document.issuer.contact_person)draw(`担当 ${document.issuer.contact_person}`);
    if(document.report.show_fax!==0&&document.issuer.fax)draw(`FAX ${document.issuer.fax}`);
    if(document.report.show_email!==0&&document.issuer.email)draw(document.issuer.email);}
  y-=10;
  if(document.invitation&&document.qr){
    const image=await pdf.embedPng(document.qr);if(y<330){page=pdf.addPage([595.28,841.89]);y=790;}page.drawImage(image,{x:190,y:y-200,width:200,height:200});y-=225;
    draw('1. LINEでQRコードを読み取ってください。');draw('2. 取引先名を確認し、ご担当者名を入力します。');draw('3. 登録後、リッチメニューから注文できます。');draw(document.note);
  } else {
    draw(`${document.amountLabel||'ご請求金額'}　${yen(document.total)}`,left,19);if(document.due)draw(`お支払期日 ${document.due}`);
    y-=10;draw('商品名 / 容量 / 数量 / 税抜単価 / 金額');
    for(const row of document.rows)draw(row.join('　'));
    y-=12;draw(`税抜小計 ${yen(document.subtotal)}`);if(document.shipping)draw(`配送料 ${yen(document.shipping)}`);draw(`${document.referenceTax?'参考消費税':'消費税'} ${yen(document.tax)}`);draw(`税込合計 ${yen(document.total)}`,left,14);
    if(document.bank){y-=8;draw('お振込先');draw(document.bank);}y-=8;draw(document.note);
  }
  const bytes=await pdf.save(),blob=new Blob([bytes.slice().buffer],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=window.document.createElement('a');
  a.href=url;a.download=`${document.title}_${document.number||'招待案内'}.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
type ReportContext = { kind: 'invoice' | 'delivery-note'; id: string; historical: boolean; editable: boolean; version: number };
type SaveRequest = { version: number; request_id: string; changes: InvoicePresentation };
class ReportRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function reportRequest(path: string, payload?: unknown): Promise<Row> {
  const response = await fetch(path, { credentials: 'include', ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
  const result = await response.json().catch(() => ({})) as Row;
  if (!response.ok) throw new ReportRequestError(result.error?.message || `帳票を取得・保存できませんでした（${response.status}）。`, response.status);
  return result.data;
}
export default function Reports(){
  const location=useLocation(),navigate=useNavigate();
  const [doc,setDoc]=useState<Document|null>(null),[source,setSource]=useState<Row|null>(null),[context,setContext]=useState<ReportContext|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[success,setSuccess]=useState(''),[reload,setReload]=useState(0);
  const [editing,setEditing]=useState(false),[form,setForm]=useState<InvoicePresentation|null>(null),[preview,setPreview]=useState<Document|null>(null);
  const [request,setRequest]=useState<SaveRequest|null>(null),[confirm,setConfirm]=useState(false),[locked,setLocked]=useState(false),[conflict,setConflict]=useState(false);
  const generation=useRef(0),saving=useRef(false);
  useEffect(()=>{
    const expected=++generation.current;
    const active=()=>generation.current===expected;
    setError('');setSuccess('');setDoc(null);setSource(null);setContext(null);setEditing(false);setForm(null);setPreview(null);setRequest(null);setLocked(false);setConflict(false);setConfirm(false);setBusy(false);
    async function load(){
      const part=location.pathname.split('/reports/')[1]??'';
      if(part.startsWith('invitation')){
        const invitation=(location.state as Row)?.invitation;if(!invitation?.url)throw new Error('招待URLが見つかりません。取引先管理の「QRを表示・保存」から開き直してください。');
        const qr=await QRCode.toDataURL(invitation.url,{width:600,margin:2,errorCorrectionLevel:'M'});
        if(active())setDoc({title:'LINE注文 ご登録のご案内',number:invitation.id??'',date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),recipient:invitation.company_name??'お取引先',address:'',issuer:{company_name:'小島醸造'},report:{},rows:[],subtotal:0,shipping:0,tax:0,total:0,bank:'',note:`有効期限：${invitation.expires_at?.slice(0,10)??'未設定'}　登録上限：${invitation.max_uses??'無制限'}名\nこの案内は対象取引先の方だけでご利用ください。`,qr,invitation:true});return;
      }
      const parts=part.split('/');const id=decodeURIComponent(parts[1]||'');const historical=parts[2]==='history'&&!!parts[3];let path='';
      const linkedInvoice=new URLSearchParams(location.search).get('invoice_id');
      if(parts[0]==='order'&&id)path=historical?`/api/admin/orders/${encodeURIComponent(id)}/delivery-notes/${encodeURIComponent(decodeURIComponent(parts[3]))}`:linkedInvoice?`/api/admin/invoices/${encodeURIComponent(linkedInvoice)}/delivery-notes/preview?${new URLSearchParams({order_id:id})}`:`/api/admin/orders/${encodeURIComponent(id)}/delivery-note`;
      else if(parts[0]==='invoice'&&id)path=historical?`/api/admin/invoices/${encodeURIComponent(id)}/history/${encodeURIComponent(decodeURIComponent(parts[3]))}`:`/api/admin/invoices/${encodeURIComponent(id)}`;
      else throw new Error('帳票が指定されていません。');
      const result=await reportRequest(path);let data=result.snapshot??(result.snapshot_json?JSON.parse(result.snapshot_json):result);
      if(!active())return;
      if(parts[0]==='order'&&!historical)data={...data,is_draft:true};
      setSource(data);setDoc(normalize(data));setContext({kind:parts[0]==='invoice'?'invoice':'delivery-note',id,historical,editable:parts[0]==='invoice'&&!historical&&(result.can_edit_presentation??['issued','paid'].includes(result.status)),version:Number(result.latest_version??data.version)});
    }
    void load().catch(error=>{if(active())setError(error instanceof Error?error.message:'帳票を読み込めませんでした。');});
    return()=>{++generation.current;};
  },[location.pathname,location.search,location.state,reload]);
  async function download(){if(!doc||editing||saving.current)return;setBusy(true);setError('');try{await pdfDocument(doc);}catch(error){setError(error instanceof Error?error.message:'PDFを作成できませんでした。');}finally{setBusy(false);}}
  function startEdit(){if(!source||!context?.editable||busy)return;setForm(invoicePresentation(source));setEditing(true);setPreview(null);setRequest(null);setError('');setSuccess('');setLocked(false);setConflict(false);}
  function changeForm(value:InvoicePresentation){setForm(value);setPreview(null);setRequest(null);setError('');setLocked(false);setConflict(false);}
  function previewEdit(){if(!source||!form||!context||locked)return;setPreview(normalize(applyInvoicePresentation(source,form)));setRequest({version:context.version,request_id:crypto.randomUUID(),changes:structuredClone(form)});setError('');}
  function closeEdit(){if(saving.current)return;setEditing(false);setForm(null);setPreview(null);setRequest(null);setLocked(false);setConfirm(false);setError('');setConflict(false);}
  async function save(){
    if(!context?.editable||!request||saving.current)return;
    saving.current=true;setBusy(true);setError('');const expected=generation.current;
    try{
      const result=await reportRequest(`/api/admin/invoices/${encodeURIComponent(context.id)}/presentation`,request);
      if(expected!==generation.current)return;
      const snapshot=result.snapshot??(result.snapshot_json?JSON.parse(result.snapshot_json):null);
      if(!snapshot)throw new Error('保存後の帳票を確認できませんでした。最新の内容を読み直してください。');
      setSource(snapshot);setDoc(normalize(snapshot));setContext({...context,version:Number(result.latest_version??snapshot.version),editable:result.can_edit_presentation??['issued','paid'].includes(result.status)});
      setEditing(false);setForm(null);setPreview(null);setRequest(null);setLocked(false);setConfirm(false);setConflict(false);setSuccess(`第${result.latest_version??snapshot.version}版として保存しました。以前の版は発行履歴から確認できます。`);
    }catch(error){
      if(expected!==generation.current)return;
      const status=error instanceof ReportRequestError?error.status:null;
      setError((error instanceof Error?error.message:'保存結果を確認できませんでした。')+(status===409?' 最新の内容を読み直してから編集してください。':''));setLocked(true);setConflict(status===409);setConfirm(false);
    }finally{saving.current=false;if(expected===generation.current)setBusy(false);}
  }
  const shown=preview??doc;
  return <div className="report-page">
    <div className="report-toolbar"><button disabled={busy} onClick={()=>navigate(-1)}><ArrowLeft size={18}/>戻る</button><span>帳票プレビュー{doc?.version?` · 第${doc.version}版`:''}</span>{context?.editable&&!editing&&<button disabled={busy} onClick={startEdit}><Pencil size={18}/>表示内容を編集</button>}<button disabled={!doc||busy||editing} onClick={download}><Download size={18}/>{busy?'処理中…':'PDFダウンロード'}</button><button disabled={!doc||editing||busy} onClick={()=>window.print()}><Printer size={18}/>印刷</button></div>
    {context?.kind==='invoice'&&<div className="report-calculation-warning" role="note"><AlertCircle size={20}/><div><strong>計算結果を保つための注意</strong><p>{presentationWarning}</p><p>表示内容の修正は新しい版として保存し、以前の発行内容は履歴に残ります。</p></div></div>}
    {context?.historical&&<p className="report-snapshot-notice" role="status">発行履歴のプレビュー <span>発行時に保存した内容を表示しています。</span></p>}
    {context?.kind==='delivery-note'&&!context.historical&&<p className="report-snapshot-notice" role="status">未発行のプレビュー <span>現在の注文・会社設定を表示しています。履歴へ保存するには、請求管理の「納品書を発行」を使用してください。</span></p>}
    {error&&<div role="alert" className="report-error"><AlertCircle size={18}/><div>{error}{conflict&&<button type="button" disabled={busy} onClick={()=>setReload(value=>value+1)}><RefreshCw size={17}/>最新の内容を読み直す</button>}</div></div>}
    {success&&<p className="report-success" role="status">{success}</p>}
    {editing&&form&&source&&<InvoicePresentationEditor value={form} onChange={changeForm} onPreview={previewEdit} onCancel={closeEdit} onSave={()=>setConfirm(true)} previewed={!!request&&!conflict} busy={busy} locked={locked} conflict={conflict} unchanged={JSON.stringify(form)===JSON.stringify(invoicePresentation(source))}/>}
    {!shown&&!error?<p role="status">帳票を読み込み中…</p>:shown&&<article className="report-sheet">{shown.draft&&<p className="report-draft-label">未発行のプレビュー</p>}{editing&&<p className="report-draft-label">編集中・未保存のプレビュー</p>}<h1>{shown.title}</h1><div className="report-number">発行日：{shown.date}<br/>{shown.number}{shown.version?`　 第${shown.version}版`:''}</div><div className="report-parties"><div><h2>{shown.recipient} 御中</h2><p>{shown.address}</p></div>{shown.report.show_issuer_info!==0&&<div><strong>{shown.issuer.display_name||shown.issuer.company_name||'小島醸造'}</strong><p>{shown.issuer.postal_code}<br/>{shown.issuer.address}<br/>TEL：{shown.issuer.tel||'未登録'}{shown.report.show_fax!==0&&shown.issuer.fax&&<><br/>FAX：{shown.issuer.fax}</>}{shown.report.show_email!==0&&shown.issuer.email&&<><br/>{shown.issuer.email}</>}{shown.report.show_invoice_reg_no!==0&&shown.issuer.invoice_reg_no&&<><br/>登録番号：{shown.issuer.invoice_reg_no}</>}{shown.report.show_contact_person!==0&&shown.issuer.contact_person&&<><br/>担当：{shown.issuer.contact_person}</>}</p></div>}</div>{shown.invitation?<div className="report-invitation"><p>いつもお引き立ていただきありがとうございます。<br/>LINEから簡単にご注文いただけます。</p><img src={shown.qr} alt="取引先専用LINE登録QRコード"/><ol><li>LINEでQRコードを読み取ります。</li><li>取引先名を確認し、ご担当者名を入力します。</li><li>登録後、リッチメニューからご注文ください。</li></ol></div>:<><div className="report-total">{shown.amountLabel||'ご請求金額'} <strong>{yen(shown.total)}</strong></div>{shown.due&&<p>お支払期日：{shown.due}</p>}<table><thead><tr>{['商品名','容量','数量','税抜単価','金額'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{shown.rows.map((row,i)=><tr key={i}>{row.map((x,j)=><td key={j}>{x}</td>)}</tr>)}</tbody></table><div className="report-sums"><p>税抜小計<span>{yen(shown.subtotal)}</span></p>{!!shown.shipping&&<p>配送料<span>{yen(shown.shipping)}</span></p>}<p>{shown.referenceTax?'参考消費税':'消費税'}<span>{yen(shown.tax)}</span></p><p className="report-sum-total">税込合計<span>{yen(shown.total)}</span></p></div>{shown.referenceTax&&<p>※消費税は参考税額です。請求書発行時に正式税額を計算します。</p>}{shown.bank&&<div className="report-bank"><strong>お振込先</strong><p>{shown.bank}</p></div>}</>}<div className="report-note"><strong>備考</strong><p>{shown.note}</p></div></article>}
    <ConfirmDialog open={confirm} title="請求書の表示内容を保存しますか？" busy={busy} onClose={()=>{if(!busy)setConfirm(false);}} onConfirm={()=>void save()}><p>宛名・期日・備考・発行元・振込先の修正を新しい版として保存します。商品明細・計算結果・注文のロックは維持します。</p><p>保存前に宛名と振込先が正しいことを確認してください。以前の版は発行履歴に残ります。</p></ConfirmDialog>
  </div>;
}
