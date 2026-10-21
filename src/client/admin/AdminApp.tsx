import '@fontsource/noto-sans-jp/japanese-400.css';
import '@fontsource/noto-sans-jp/japanese-500.css';
import '@fontsource/noto-sans-jp/japanese-700.css';
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Link, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, ShoppingCart, Users, Wine, Truck, FileText, History, Settings, LogOut, ChevronLeft, ChevronRight, Menu, ArrowUpRight, ArrowDownRight, Minus, UserRound, ShieldCheck, LoaderCircle } from 'lucide-react';
import { api, date, money } from './api';
import { Badge, Loading, Empty, ErrorBox, FieldHelp, useRowNavigation } from './ui';
import Orders from './Orders';
import Companies from './Companies';
import Invoices from './Invoices';
import Masters from './Masters';
import Reports from '../Reports';
import '../admin.css';

const navigation = [ ['','ダッシュボード',LayoutDashboard], ['orders','注文管理',ShoppingCart], ['companies','取引先管理',Users], ['products','商品管理',Wine], ['shipping','配送管理',Truck], ['invoices','請求管理',FileText], ['audit','監査ログ',History], ['settings','設定',Settings] ] as const;

export default function AdminApp() {
 const [user,setUser]=useState<any>(null),[checking,setChecking]=useState(true),[collapsed,setCollapsed]=useState(false),[mobile,setMobile]=useState(false);
 const navigate=useNavigate(),location=useLocation();
 const check=()=>{ setChecking(true);api('/api/auth/me').then(data=>{ const admin=data?.admin || (data?.actor?.type==='admin'?data.actor:null) || (data?.type==='admin'?data.user||data:data?.role?data:null);setUser(admin) }).catch(()=>setUser(null)).finally(()=>setChecking(false)) };
 useEffect(check,[]);
 useEffect(()=>setMobile(false),[location.pathname]);
 if(checking) return <div className="admin-root"><Loading/></div>;
 if(!user || location.pathname==='/admin/login')return <Login onLogin={()=>{check();navigate('/admin')}}/>;
 async function logout(){try{await api('/api/auth/logout',{method:'POST'});setUser(null);navigate('/admin/login')}catch(e){window.alert((e as Error).message)}}
 return <div className={`admin-root ${collapsed?'is-collapsed':''} ${mobile?'mobile-open':''}`}>
  {mobile&&<button className="admin-sidebar-shade" aria-label="メニューを閉じる" onClick={()=>setMobile(false)}/>}
  <aside className="admin-sidebar"><Link className="admin-brand" to="/admin"><span className="admin-brand-mark">小島醸造<span>KOJIMA BREWERY</span></span><span className="admin-brand-caption">受注管理ポータル</span></Link><nav aria-label="管理メニュー">{navigation.map(([path,label,Icon])=><NavLink end={!path} key={path} to={`/admin/${path}`} className={({isActive})=>isActive?'active':''} title={label}><Icon size={23} strokeWidth={1.7}/><span>{label}</span></NavLink>)}</nav><div className="admin-sidebar-footer"><div className="admin-sidebar-status"><span/>システム稼働中</div><button onClick={()=>setCollapsed(!collapsed)}><span className="admin-collapse-icon">{collapsed?<ChevronRight size={16}/>:<ChevronLeft size={16}/>}</span><span>メニューを閉じる</span></button></div></aside>
  <div className="admin-workspace"><header className="admin-topbar"><button className="admin-icon-btn admin-mobile-toggle" aria-label="メニューを開く" onClick={()=>setMobile(!mobile)}><Menu/></button><div className="admin-top-breadcrumb">受注管理ポータル <span aria-hidden="true">/</span> <span>{navigation.find(([p])=>p ? location.pathname.startsWith(`/admin/${p}`):location.pathname==='/admin'||location.pathname==='/admin/')?.[1]||'帳票プレビュー'}</span></div><div className="admin-account"><span className="admin-top-company">小島醸造</span><span className="admin-account-avatar"><UserRound size={19}/></span><span>{user.name || '管理者'}</span><button className="admin-icon-btn" onClick={logout} title="ログアウト" aria-label="ログアウト"><LogOut size={18}/></button></div></header>
   <main className="admin-main"><Routes><Route index element={<Dashboard/>}/><Route path="orders/*" element={<Orders/>}/><Route path="companies/*" element={<Companies/>}/><Route path="products/*" element={<Masters section="products"/>}/><Route path="shipping/*" element={<Masters section="shipping"/>}/><Route path="invoices/*" element={<Invoices/>}/><Route path="audit/*" element={<Masters section="audit"/>}/><Route path="settings/*" element={<Masters section="settings" userRole={user.role}/>}/><Route path="reports/*" element={<Reports/>}/><Route path="*" element={<Dashboard/>}/></Routes></main><footer className="admin-bottom">小島醸造 受注管理ポータル<span>© {new Date().getFullYear()} Kojima Brewery</span></footer>
  </div>
 </div>
}

function Login({onLogin}:{onLogin:()=>void}){
 const [login,setLogin]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[demo,setDemo]=useState(false);
 useEffect(()=>{api('/api/config').then(c=>setDemo(!!c.demo_enabled)).catch(()=>{})},[]);
 async function submit(e?:FormEvent,isDemo=false){e?.preventDefault();setError('');setBusy(true);try{await api(isDemo?'/api/auth/demo/admin':'/api/auth/admin/login',{method:'POST',body:JSON.stringify(isDemo?{}:{login_id:login,password})});onLogin()}catch(err){setError((err as Error).message)}finally{setBusy(false)}}
 return <div className="admin-login"><div className="admin-login-story"><div className="admin-login-emblem">小島醸造</div><span className="admin-eyebrow">KOJIMA BREWERY · INUYAMA</span><h1>大切な一杯を、<br/>確かなつながりで。</h1><p>受注からお届けまで。<br/>小島醸造の日々の仕事を、ひとつの場所に。</p><div className="admin-login-line"/><small>ORDER MANAGEMENT PORTAL</small></div><div className="admin-login-form"><div className="admin-login-box"><span className="admin-login-shield"><ShieldCheck size={26}/></span><h2>管理者ログイン</h2><p className="admin-muted">管理者IDとパスワードを入力してください。</p><ErrorBox error={error}/><form onSubmit={submit}><label className="admin-field"><FieldHelp label="管理者ID" help="環境の管理者から案内されたログインIDを入力してください。"/><input autoComplete="username" className="admin-input" value={login} onChange={e=>setLogin(e.target.value)} required placeholder="例：admin"/></label><label className="admin-field"><FieldHelp label="パスワード" help="管理者用に設定したパスワードを入力してください。文字は伏せて表示されます。"/><input autoComplete="current-password" className="admin-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} required placeholder="設定済みのパスワード"/></label><button className="admin-btn primary admin-login-submit" disabled={busy}>{busy?<LoaderCircle className="admin-spin" size={18}/>:null}ログイン</button></form>{demo&&<div className="admin-demo-entry"><span>開発・動作確認用</span><button className="admin-btn secondary" onClick={()=>submit(undefined,true)} disabled={busy}>デモ環境を開く</button><small>サンプルデータで管理機能を確認できます。</small></div>}<Link to="/" className="admin-login-back">お取引先向けページへ</Link></div><small className="admin-login-copyright">© {new Date().getFullYear()} 小島醸造</small></div></div>
}

export function OrderTable({orders}:{orders:any[]}) {
 const rowNavigation=useRowNavigation();
 return <div className="admin-table-wrap"><table className="admin-table admin-orders-table admin-record-table"><thead><tr><th>注文番号</th><th>会社名</th><th>注文日時</th><th>到着希望日</th><th className="num">税込合計</th><th>ステータス</th><th>請求</th></tr></thead><tbody>{orders.map(o=><tr {...rowNavigation(`/admin/orders/${o.id}`,`${o.company_name}の注文 ${o.id}の詳細`)} key={o.id}>
  <td data-label="注文番号"><Link className="admin-order-id" to={`/admin/orders/${o.id}`}>{o.id}</Link></td><td data-label="会社名" className="admin-company-name">{o.company_name||'—'}</td><td data-label="注文日時" className="admin-cell-muted">{date(o.ordered_at,true)}</td><td data-label="到着希望日">{date(o.desired_delivery_date)}</td><td data-label="税込合計" className="num admin-tabular">{money(o.total_amount)}</td><td data-label="ステータス"><Badge value={o.status}/></td><td data-label="請求"><span className={`admin-invoice-flag ${o.is_invoice_locked?'issued':''}`}>{o.is_invoice_locked?'済':'未'}</span></td>
 </tr>)}</tbody></table>{!orders.length&&<Empty text="注文はまだありません"/>}</div>
}

function Dashboard(){
 const [data,setData]=useState<any>(null),[error,setError]=useState('');
 useEffect(()=>{api('/api/admin/dashboard').then(setData).catch(e=>setError(e.message))},[]);
 const now=new Date(),today=new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short',timeZone:'Asia/Tokyo'}).format(now);
 const cards=[{label:'本日の新規注文',key:'new_orders',yesterday:'yesterday_new_orders',icon:ShoppingCart,tone:'blue',href:'/admin/orders'},{label:'確認待ち',key:'pending_confirmation',yesterday:'yesterday_pending_confirmation',icon:FileText,tone:'gold',href:'/admin/orders?status=received'},{label:'本日の到着予定',key:'arriving_today',yesterday:'yesterday_arriving_today',icon:Truck,tone:'green',href:`/admin/orders?delivery_date=${new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(now)}`},{label:'配送準備中',key:'preparing',yesterday:'yesterday_preparing',icon:PackageIcon,tone:'violet',href:'/admin/orders?status=preparing'}];
 return <><div className="admin-page-head dashboard"><div><span className="admin-eyebrow">OVERVIEW</span><h1>ダッシュボード</h1><p>本日の受注・配送状況をご確認いただけます。</p></div><div className="admin-today">{today}</div></div><ErrorBox error={error}/>{!data&&!error?<Loading/>:<><div className="admin-kpi-grid">{cards.map(({label,key,yesterday,icon:Icon,tone,href})=><Link key={key} to={href} className={`admin-kpi ${tone}`}><span className="admin-kpi-icon"><Icon size={31} strokeWidth={1.7}/></span><div className="admin-kpi-body"><span className="admin-kpi-label">{label}</span><div className="admin-kpi-number">{Number(data?.[key]||0)}<span>件</span></div><div className="admin-kpi-compare">{data?.[yesterday]!=null?<><span>昨日：{data[yesterday]}件</span>{data[key]>data[yesterday]?<ArrowUpRight size={18}/>:data[key]<data[yesterday]?<ArrowDownRight size={18}/>:<Minus size={18}/>}</>:<span>最新の受注状況</span>}</div></div></Link>)}</div><section className="admin-card admin-recent"><div className="admin-card-head"><div><h2>最近の注文</h2><span className="admin-muted">新しく届いた注文を確認しましょう</span></div><Link className="admin-text-link" to="/admin/orders">すべての注文を見る</Link></div><OrderTable orders={data?.recent_orders||[]}/></section><section className="admin-card admin-quick"><div className="admin-card-head"><h2>クイックメニュー</h2></div><div className="admin-quick-grid">{[['orders','注文管理','注文の確認・編集・ステータス変更',ShoppingCart],['companies','取引先管理','取引先・配送先・LINE利用者',Users],['products','商品管理','商品情報・販売単価',Wine],['shipping','配送管理','配送カレンダー・梱包・送料',Truck],['invoices','請求管理','請求書の作成・発行・履歴',FileText],['settings','設定','会社情報・税・帳票・その他',Settings]].map(([path,title,description,Icon]:any)=><Link className="admin-quick-item" key={path} to={`/admin/${path}`}><span className="admin-quick-icon"><Icon size={25} strokeWidth={1.8}/></span><div><strong>{title}</strong><span>{description}</span></div></Link>)}</div></section><div className="admin-help-note"><ShieldCheck size={15}/>大切な変更は履歴に記録されます。安心して日々の業務にお使いいただけます。</div></> }</>
}
function PackageIcon(props:any){return <svg {...props} width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={props.strokeWidth}><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5"/></svg>}
