import { useEffect,useRef,useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Printer, AlertCircle } from 'lucide-react';
import QRCode from 'qrcode';
import './reports.css';
type Row=Record<string,any>;
type Document={title:string;number:string;date:string;recipient:string;address:string;issuer:Row;report:Row;rows:string[][];subtotal:number;shipping:number;tax:number;total:number;note:string;bank:string;version?:number;due?:string;qr?:string;invitation?:boolean;referenceTax?:boolean};
const yen=(n:number)=>`${Number(n??0).toLocaleString('ja-JP')}円`;
function normalize(data:Row):Document {
  const invoice=data.kind==='invoice',order=data.order??{},bill=data.invoice??{},report=data.report_settings??{},issuer=data.issuer??{};
  const shipping=invoice?(data.orders??[]).reduce((sum:number,o:Row)=>sum+Number(o.shipping_fee??0),0):Number(order.shipping_fee??0);
  const itemRows=(items:Row[])=>items.map((r:Row)=>[r.snap_product_name||r.product_name||'',`${r.snap_volume_ml??''}ml`,`${r.quantity} ${r.snap_unit||'本'}`,yen(r.unit_price),yen(r.subtotal)]);
  const rows=invoice&&data.orders?.length?data.orders.flatMap((o:Row)=>[[`${o.desired_delivery_date}　${o.id}`,'','','',''],...itemRows(o.items??[])]):itemRows(data.items??order.items??[]);
  return {title:invoice?(report.invoice_title||'御請求書'):(report.delivery_note_title||'納品書'),number:invoice?bill.id:order.id,date:invoice?bill.issued_date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),recipient:invoice?data.company?.name:order.company_name||order.snap_recipient_name,address:invoice?data.company?.address||'':`${order.snap_postal_code||''} ${order.snap_address||''}`,issuer,report,
    rows,
    subtotal:invoice?Number(data.subtotal_excl_tax)-shipping:order.items_subtotal,shipping,tax:invoice?data.tax_amount:order.tax_amount,total:invoice?data.total_incl_tax:order.total_amount,
    note:invoice?(bill.note||report.invoice_note_template||''):(order.note||report.delivery_note_template||''),
    bank:invoice&&issuer.bank_name?`${issuer.bank_name} ${issuer.bank_branch_name||''} ${issuer.bank_account_type||''} ${issuer.bank_account_number||''}\n${issuer.bank_account_holder||''}`:'',version:data.version,due:bill.due_date,
    referenceTax:!invoice&&order.snap_tax_calc_unit==='invoice'};
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
    draw(`ご請求金額　${yen(document.total)}`,left,19);if(document.due)draw(`お支払期日 ${document.due}`);
    y-=10;draw('商品名 / 容量 / 数量 / 税抜単価 / 金額');
    for(const row of document.rows)draw(row.join('　'));
    y-=12;draw(`税抜小計 ${yen(document.subtotal)}`);if(document.shipping)draw(`配送料 ${yen(document.shipping)}`);draw(`${document.referenceTax?'参考消費税':'消費税'} ${yen(document.tax)}`);draw(`税込合計 ${yen(document.total)}`,left,14);
    if(document.bank){y-=8;draw('お振込先');draw(document.bank);}y-=8;draw(document.note);
  }
  const bytes=await pdf.save(),blob=new Blob([bytes.slice().buffer],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=window.document.createElement('a');
  a.href=url;a.download=`${document.title}_${document.number||'招待案内'}.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export default function Reports(){
  const location=useLocation(),navigate=useNavigate(),[doc,setDoc]=useState<Document|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;setError('');setDoc(null);
    async function load(){
      const part=location.pathname.split('/reports/')[1]??'';
      if(part.startsWith('invitation')){
        const invitation=(location.state as Row)?.invitation;if(!invitation?.url)throw new Error('招待URLは発行直後にだけ表示されます。取引先管理からQRコードを再発行してください。');
        const qr=await QRCode.toDataURL(invitation.url,{width:600,margin:2,errorCorrectionLevel:'M'});
        if(mounted.current)setDoc({title:'LINE注文 ご登録のご案内',number:invitation.id??'',date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),recipient:invitation.company_name??'お取引先',address:'',issuer:{company_name:'小島醸造'},report:{},rows:[],subtotal:0,shipping:0,tax:0,total:0,bank:'',note:`有効期限：${invitation.expires_at?.slice(0,10)??'未設定'}　登録上限：${invitation.max_uses??'無制限'}名\nこの案内は対象取引先の方だけでご利用ください。`,qr,invitation:true});return;
      }
      const parts=part.split('/');let path='';
      if(parts[0]==='order'&&parts[1])path=`/api/admin/orders/${encodeURIComponent(parts[1])}/delivery-note`;
      else if(parts[0]==='invoice'&&parts[1])path=parts[3]?`/api/admin/invoices/${encodeURIComponent(parts[1])}/history/${encodeURIComponent(parts[3])}`:`/api/admin/invoices/${encodeURIComponent(parts[1])}`;
      else throw new Error('帳票が指定されていません。');
      const response=await fetch(path,{credentials:'include'}),result=await response.json() as Row;if(!response.ok)throw new Error(result.error?.message||'帳票を取得できませんでした。');
      let data=result.data;if(data.snapshot)data=data.snapshot;else if(data.snapshot_json)data=JSON.parse(data.snapshot_json);
      if(mounted.current)setDoc(normalize(data));
    }load().catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};
  },[location.pathname,location.state]);
  async function download(){if(!doc)return;setBusy(true);setError('');try{await pdfDocument(doc);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="report-page"><div className="report-toolbar"><button onClick={()=>navigate(-1)}><ArrowLeft size={18}/>戻る</button><span>帳票プレビュー{doc?.version?` · 第${doc.version}版`:''}</span><button disabled={!doc||busy} onClick={download}><Download size={18}/>{busy?'PDF作成中…':'PDFダウンロード'}</button><button disabled={!doc} onClick={()=>window.print()}><Printer size={18}/>印刷</button></div>{error&&<div role="alert" className="report-error"><AlertCircle size={18}/>{error}</div>}{!doc&&!error?<p role="status">帳票を読み込み中…</p>:doc&&<article className="report-sheet"><h1>{doc.title}</h1><div className="report-number">発行日：{doc.date}<br/>{doc.number}{doc.version?`　 第${doc.version}版`:''}</div><div className="report-parties"><div><h2>{doc.recipient} 御中</h2><p>{doc.address}</p></div>{doc.report.show_issuer_info!==0&&<div><strong>{doc.issuer.display_name||doc.issuer.company_name||'小島醸造'}</strong><p>{doc.issuer.postal_code}<br/>{doc.issuer.address}<br/>TEL：{doc.issuer.tel||'未登録'}{doc.report.show_fax!==0&&doc.issuer.fax&&<><br/>FAX：{doc.issuer.fax}</>}{doc.report.show_email!==0&&doc.issuer.email&&<><br/>{doc.issuer.email}</>}{doc.report.show_invoice_reg_no!==0&&doc.issuer.invoice_reg_no&&<><br/>登録番号：{doc.issuer.invoice_reg_no}</>}{doc.report.show_contact_person!==0&&doc.issuer.contact_person&&<><br/>担当：{doc.issuer.contact_person}</>}</p></div>}</div>{doc.invitation?<div className="report-invitation"><p>いつもお引き立ていただきありがとうございます。<br/>LINEから簡単にご注文いただけます。</p><img src={doc.qr} alt="取引先専用LINE登録QRコード"/><ol><li>LINEでQRコードを読み取ります。</li><li>取引先名を確認して、ご担当者名を入力します。</li><li>登録後、リッチメニューからご注文ください。</li></ol></div>:<><div className="report-total">ご請求金額 <strong>{yen(doc.total)}</strong></div>{doc.due&&<p>お支払期日：{doc.due}</p>}<table><thead><tr>{['商品名','容量','数量','税抜単価','金額'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{doc.rows.map((row,i)=><tr key={i}>{row.map((x,j)=><td key={j}>{x}</td>)}</tr>)}</tbody></table><div className="report-sums"><p>税抜小計<span>{yen(doc.subtotal)}</span></p>{!!doc.shipping&&<p>配送料<span>{yen(doc.shipping)}</span></p>}<p>{doc.referenceTax?'参考消費税':'消費税'}<span>{yen(doc.tax)}</span></p><p className="report-sum-total">税込合計<span>{yen(doc.total)}</span></p></div>{doc.referenceTax&&<p>※消費税は参考税額です。請求書発行時に正式税額を計算します。</p>}{doc.bank&&<div className="report-bank"><strong>お振込先</strong><p>{doc.bank}</p></div>}</>}<div className="report-note"><strong>備考</strong><p>{doc.note}</p></div></article>}</div>;
}
