import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import liff from '@line/liff';
import { AlertCircle, ArrowLeft, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronRight, ClipboardList, Clock, LoaderCircle, Mail, MapPin, MessageCircle, Minus, Package, Phone, Plus, RefreshCw, Search, ShieldCheck, ShoppingBag, Truck, Wine, X } from 'lucide-react';
import { addressName, addressText, api, ApiError, formatDate, money, productName, statuses, useResource } from './api';
import type { Address, Product, Quote } from './api';
import { resolveProductImageUrl } from '../../shared/product-image';
import '../customer.css';

interface Config { liff_id?: string; environment: string; demo_enabled: boolean; }
interface CustomerAuth { actor: any; config: Config | null; loading: boolean; lineReady: boolean; lineAuthenticated: boolean; lineProfile: any; error: string | null; refresh: () => Promise<void>; demo: () => Promise<void>; login: () => void; }
const AuthContext = createContext<CustomerAuth>(null!);
const useAuth = () => useContext(AuthContext);
function lineCredentials(): { id_token: string } | { access_token: string } | null {
  const idToken = liff.getIDToken();
  if (idToken) return { id_token: idToken };
  const accessToken = liff.getAccessToken();
  return accessToken ? { access_token: accessToken } : null;
}
const lineCredentialError = 'LINEの認証情報を取得できませんでした。招待URLを開き直すか、LINEの認証をやり直してください。';

function AuthProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<any>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [lineReady, setLineReady] = useState(false);
  const [lineAuthenticated, setLineAuthenticated] = useState(false);
  const [lineProfile, setLineProfile] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { const result = await api('/api/auth/me'); setActor(result?.actor || null); }
    catch (err) { if (!(err instanceof ApiError && err.status === 401)) setError((err as Error).message); setActor(null); }
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const settings = await api<Config>('/api/config');
        if (!active) return;
        setConfig(settings);
        if (settings.liff_id) {
          // A cookie from another LINE account must not determine this account's company.
          setActor(null); setLineAuthenticated(false); setLineProfile(null); setError(null);
          await liff.init({ liffId: settings.liff_id });
          if (!active) return;
          setLineReady(true);
          if (liff.isLoggedIn()) {
            const credentials = lineCredentials();
            if (!credentials) throw new Error(lineCredentialError);
            try {
              const result = await api('/api/auth/line', { method: 'POST', body: JSON.stringify(credentials) });
              if (!active) return;
              setActor(result?.actor || null); setLineAuthenticated(true);
            } catch (err) {
              if (!active) return;
              setActor(null);
              if (err instanceof ApiError && err.code === 'LINE_USER_NOT_REGISTERED') setLineAuthenticated(true);
              else throw err;
            }
            // A display-name lookup is optional; it cannot block verified authentication.
            void Promise.resolve().then(() => liff.getProfile()).then(profile => { if (active) setLineProfile(profile); }).catch(() => {});
          }
        } else await refresh();
      } catch (err) { if (active) setError((err as Error).message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [refresh]);
  const demo = async () => { setLoading(true); setError(null); try { await api('/api/auth/demo/customer', { method: 'POST', body: '{}' }); await refresh(); } catch (err) { setError((err as Error).message); } finally { setLoading(false); } };
  const login = () => {
    if (!lineReady) return;
    const redirectUri = window.location.href;
    setActor(null); setLineAuthenticated(false); setLineProfile(null); setError(null);
    try { if (liff.isLoggedIn()) liff.logout(); liff.login({ redirectUri }); }
    catch { setError('LINEの認証を開始できませんでした。招待URLを開き直してください。'); }
  };
  return <AuthContext.Provider value={{ actor, config, loading, lineReady, lineAuthenticated, lineProfile, error, refresh, demo, login }}>{children}</AuthContext.Provider>;
}

export default function CustomerApp() {
  return <AuthProvider><CustomerShell /></AuthProvider>;
}

function CustomerShell() {
  const { config } = useAuth();
  const location = useLocation();
  useEffect(() => { window.scrollTo({ top: 0 }); }, [location.pathname]);
  return <div className="ko-customer">
    {config?.demo_enabled && <div className="ko-dev-banner">開発・検証環境 — 実際の発注・通知は行いません</div>}
    <header className="ko-header"><Link className="ko-brand" to="/order"><span><strong>小島醸造</strong><small>法人向け注文サービス</small></span></Link></header>
    <main className="ko-main"><Routes>
      <Route path="/" element={<CustomerHome />} />
      <Route path="/order/*" element={<Protected><OrderFlow /></Protected>} />
      <Route path="/orders" element={<Protected><OrderHistory /></Protected>} />
      <Route path="/orders/:id/edit/*" element={<Protected><OrderEditRoute /></Protected>} />
      <Route path="/orders/:id" element={<Protected><OrderDetail /></Protected>} />
      <Route path="/products" element={<ProductList />} />
      <Route path="/products/:id" element={<ProductDetail />} />
      <Route path="/contact" element={<Contact />} />
      <Route path="/invite/*" element={<Invite />} />
      <Route path="/error" element={<Unavailable title="ご利用状況をご確認ください" message="招待状の有効期限や登録状態をご確認のうえ、小島醸造までお問い合わせください。" />} />
      <Route path="*" element={<Unavailable title="ページが見つかりません" message="下のメニューからご希望のページをお選びください。" />} />
    </Routes></main>
    <nav className="ko-nav" aria-label="メインメニュー">{[{ path: '/order', icon: ShoppingBag, label: '注文' }, { path: '/orders', icon: ClipboardList, label: '注文履歴' }, { path: '/products', icon: Wine, label: '商品紹介' }, { path: '/contact', icon: MessageCircle, label: 'お問い合わせ' }].map(({ path, icon: Icon, label }) => <NavLink key={path} to={path} className={({ isActive }) => `ko-nav-item${isActive && (path !== '/order' || !location.pathname.startsWith('/orders')) ? ' active' : ''}`}><Icon size={21} strokeWidth={1.65} /><span>{label}</span></NavLink>)}</nav>
    <footer className="ko-desktop-footer">© 小島醸造</footer>
  </div>;
}

function CustomerHome() {
  const { loading } = useAuth();
  // LIFF consumes liff.state during initialization before redirecting deep links.
  // Keep the original URL intact until initialization has completed.
  return loading ? <Loading /> : <Navigate to="/order" replace />;
}

function Protected({ children }: { children: ReactNode }) {
  const { actor, loading } = useAuth();
  if (loading) return <Loading label="ご利用状況を確認しています" />;
  if (actor?.type !== 'customer') return <LoginGate />;
  return <>{children}</>;
}

function LoginGate() {
  const { config, lineReady, lineAuthenticated, login, demo, loading, error } = useAuth();
  return <div className="ko-login"><h1>ご注文</h1><p>ご登録済みのLINEアカウントでログインしてください。</p>
    <div className="ko-panel ko-login-panel"><ShieldCheck size={26} /><h2>{lineAuthenticated ? 'お取引先への登録が必要です' : 'LINEログイン'}</h2><p>{lineAuthenticated ? 'LINEの本人確認は完了しています。企業との紐づけには、お取引先へお渡しした招待QRコードから初回登録をお願いします。友だち追加のQRコードとは異なります。' : 'ご登録済みのLINEアカウントでログインすると、お取引先専用の価格でご注文いただけます。'}</p>{lineReady && !lineAuthenticated && <button className="ko-button ko-line-button" onClick={login}>{error ? 'LINEの認証をやり直す' : 'LINEでログイン'} <ArrowRight size={18} /></button>}{!config?.liff_id && <p className="ko-muted">LINE連携の設定が完了していません。ご利用開始については小島醸造にお問い合わせください。</p>}{error && <InlineError message={error} />}<Link className="ko-text-link" to="/contact">登録・ご利用についてのお問い合わせ <ChevronRight size={15} /></Link></div>
    {config?.demo_enabled && <div className="ko-demo-box"><strong>開発環境で動作を確認</strong><p>テスト用の取引先で商品選択・注文を試せます。本番環境では表示されません。</p><button className="ko-button secondary" onClick={() => void demo()} disabled={loading}>テスト用取引先としてログイン</button></div>}
  </div>;
}

function Loading({ label = '読み込んでいます' }: { label?: string }) { return <div className="ko-loading" role="status"><LoaderCircle className="ko-spin" size={26} /><span>{label}</span></div>; }
function InlineError({ message, retry }: { message: string; retry?: () => void }) { return <div className="ko-error" role="alert"><AlertCircle size={19} /><div>{message}{retry && <button onClick={retry}><RefreshCw size={14} />再試行する</button>}</div></div>; }
function Empty({ icon: Icon = ShoppingBag, title, children }: { icon?: any; title: string; children?: ReactNode }) { return <div className="ko-empty"><Icon size={36} strokeWidth={1.2} /><h3>{title}</h3>{children && <p>{children}</p>}</div>; }
function Unavailable({ title, message }: { title: string; message: string }) { return <><div className="ko-page-heading"><h1>{title}</h1></div><div className="ko-panel"><Empty icon={ShieldCheck} title={message} /><Link className="ko-button" to="/contact">小島醸造へお問い合わせ <ChevronRight size={18} /></Link></div></>; }
function Heading({ title, children, back }: { title: string; eyebrow?: string; children?: ReactNode; back?: string }) { return <div className="ko-page-heading">{back && <Link className="ko-back" to={back}><ArrowLeft size={16} /> 戻る</Link>}<div className="ko-heading-row"><h1>{title}</h1>{children}</div></div>; }
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const original = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]'); if (!nodes?.length) return; const first = nodes[0]; const last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }; document.addEventListener('keydown', key); return () => { document.body.style.overflow = original; document.removeEventListener('keydown', key); previous?.focus(); }; }, [onClose]);
  return <div className="ko-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="ko-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="ko-sheet-handle" /><div className="ko-sheet-heading"><h2>{title}</h2><button className="ko-icon-button" aria-label="閉じる" onClick={onClose}><X size={22} /></button></div>{children}</div></div>;
}
function Bottle({ product, large = false }: { product: Product; large?: boolean }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const imageUrl = resolveProductImageUrl(product.image_url);
  const name = productName(product);
  return <div className={`ko-product-image${large ? ' large' : ''}`}>{imageUrl && imageUrl !== failedSource ? <img key={imageUrl} src={imageUrl} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedSource(imageUrl)} /> : <div className="ko-product-placeholder"><Wine size={36} strokeWidth={1.4} aria-hidden="true" /><span>画像準備中</span></div>}</div>;
}
function Quantity({ value, onChange, disabled = false, label = '数量' }: { value: number; onChange: (value: number) => void; disabled?: boolean; label?: string }) { return <div className="ko-quantity" aria-label={label}><button type="button" aria-label={`${label}を減らす`} disabled={value < 1 || disabled} onClick={() => onChange(Math.max(0, value - 1))}><Minus size={17} /></button><output aria-live="polite">{value}</output><button type="button" aria-label={`${label}を増やす`} disabled={disabled || value >= 9999} onClick={() => onChange(value + 1)}><Plus size={17} /></button></div>; }
function Status({ status }: { status: string }) { return <span className={`ko-status ${status}`}>{statuses[status] || status}</span>; }

function OrderEditRoute() { const { id } = useParams(); return <OrderFlow orderId={id} />; }
function OrderFlow({ orderId }: { orderId?: string }) {
  const { actor } = useAuth();
  const location = useLocation(); const navigate = useNavigate();
  const [products, setProducts] = useState<Product[]>([]); const [addresses, setAddresses] = useState<Address[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({}); const [addressId, setAddressId] = useState('');
  const [desiredDate, setDesiredDate] = useState(''); const [note, setNote] = useState(''); const [initialOrder, setInitialOrder] = useState<any>(null);
  const [quote, setQuote] = useState<Quote | null>(null); const [dates, setDates] = useState<string[]>([]); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [quoteError, setQuoteError] = useState<string | null>(null); const [quoting, setQuoting] = useState(false);
  const [sheet, setSheet] = useState<'cart' | 'address' | 'calendar' | null>(null); const [saving, setSaving] = useState(false); const [complete, setComplete] = useState<any>(null);
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [lock, setLock] = useState<any>(null);
  const requestId = useRef(crypto.randomUUID()); const locked = useRef(false); const quoteRevision = useRef(0);
  const base = orderId ? `/orders/${orderId}/edit` : '/order'; const confirming = location.pathname.endsWith('/confirm');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!orderId && complete && location.pathname === '/order') {
      setComplete(null); setQuantities({}); setDesiredDate(''); setNote(''); setError(null); requestId.current = crypto.randomUUID();
    }
  }, [location.pathname, complete, orderId]);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    (async () => {
      const [catalog, deliveryAddresses, original] = await Promise.all([api<Product[]>('/api/customer/catalog'), api<Address[]>('/api/customer/addresses'), orderId ? api(`/api/customer/orders/${orderId}`) : Promise.resolve(null)]);
      if (!active) return;
      setProducts(catalog); setAddresses(deliveryAddresses);
      if (original) {
        if (!original.can_edit) throw new Error('この注文は変更できません。変更期限・配送状況・請求書の発行状況をご確認ください。');
        const held = await api(`/api/customer/orders/${orderId}/lock`, { method: 'POST', body: '{}' });
        if (!active) { void api(`/api/customer/orders/${orderId}/lock`, { method: 'DELETE' }); return; }
        locked.current = true; setLock(held); setInitialOrder(original);
        setQuantities(Object.fromEntries(original.items.map((item: any) => [item.product_id, item.quantity])));
        setAddressId(original.shipping_address_id); setDesiredDate(original.desired_delivery_date); setNote(original.note || '');
        setProducts((current) => [...current.map((product) => { const previous = original.items.find((item: any) => item.product_id === product.id); return previous ? { ...product, unit_price: previous.unit_price, is_available: true, sales_status: 'on_sale' } : product; }), ...original.items.filter((item: any) => !current.some((product) => product.id === item.product_id)).map((item: any) => ({ id: item.product_id, name: item.snap_product_name, volume_ml: item.snap_volume_ml, category: item.snap_category, unit: item.snap_unit, unit_price: item.unit_price, is_available: true, sales_status: 'on_sale' }))]);
      } else { setAddressId(deliveryAddresses.find((address) => address.is_default)?.id || deliveryAddresses[0]?.id || ''); }
    })().catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (locked.current && orderId) { locked.current = false; void api(`/api/customer/orders/${orderId}/lock`, { method: 'DELETE' }).catch(() => {}); } };
  }, [orderId, reload]);
  useEffect(() => {
    if (!orderId || !lock || !locked.current) return;
    const timer = window.setInterval(() => { if (locked.current) void api(`/api/customer/orders/${orderId}/lock`, { method: 'POST', body: '{}' }).then(setLock).catch((err) => { locked.current = false; setError(`編集ロックを更新できませんでした。${err.message}`); }); }, 240000);
    const release = () => { if (locked.current) fetch(`/api/customer/orders/${orderId}/lock`, { method: 'DELETE', credentials: 'same-origin', keepalive: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } }).catch(() => {}); };
    window.addEventListener('pagehide', release); return () => { window.clearInterval(timer); window.removeEventListener('pagehide', release); };
  }, [orderId, Boolean(lock)]);
  useEffect(() => {
    if (!addressId) return; let active = true;
    api<string[]>(`/api/customer/delivery-dates?shipping_address_id=${encodeURIComponent(addressId)}`).then((result) => { if (active) { const available = initialOrder?.shipping_address_id === addressId && initialOrder.desired_delivery_date && !result.includes(initialOrder.desired_delivery_date) ? [initialOrder.desired_delivery_date, ...result] : result; setDates(available); setDesiredDate((previous) => available.includes(previous) ? previous : ''); } }).catch((err) => { if (active) setQuoteError(err.message); });
    return () => { active = false; };
  }, [addressId, initialOrder?.desired_delivery_date]);
  const items = useMemo(() => Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([product_id, quantity]) => ({ product_id, quantity })), [quantities]);
  useEffect(() => {
    if (!loading && confirming && !items.length && !complete && !error) navigate(base, { replace: true });
  }, [loading, confirming, items.length, complete, error, navigate, base]);
  useEffect(() => {
    if (location.pathname.endsWith('/addresses')) setSheet('address');
    if (location.pathname.endsWith('/calendar')) setSheet('calendar');
  }, [location.pathname]);
  const itemKey = JSON.stringify(items);
  useEffect(() => {
    if (!addressId || !items.length || complete) { setQuote(null); return; }
    const revision = ++quoteRevision.current; setQuoting(true); setQuoteError(null);
    const timer = window.setTimeout(() => { api<Quote>('/api/customer/quote', { method: 'POST', body: JSON.stringify({ shipping_address_id: addressId, desired_delivery_date: desiredDate || undefined, items, ...(orderId ? { order_id: orderId } : {}) }) }).then((result) => { if (revision === quoteRevision.current) setQuote(result); }).catch((err) => { if (revision === quoteRevision.current) { setQuote(null); setQuoteError(err.message); } }).finally(() => { if (revision === quoteRevision.current) setQuoting(false); }); }, 220);
    return () => { window.clearTimeout(timer); quoteRevision.current++; };
  }, [addressId, desiredDate, itemKey, orderId, Boolean(complete)]);
  const address = addresses.find((item) => item.id === addressId);
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = items.reduce((sum, item) => sum + Number(products.find((product) => product.id === item.product_id)?.unit_price || 0) * item.quantity, 0);
  const categories = [...new Set(products.map((product) => product.category).filter(Boolean))] as string[];
  const visible = products.filter((product) => (!query || `${productName(product)} ${product.short_description || ''}`.includes(query)) && (filter === 'all' || product.category === filter));
  const setQuantity = (id: string, value: number) => { setQuantities((previous) => ({ ...previous, [id]: value })); setQuoteError(null); };
  const confirm = () => { if (items.length && desiredDate && quote && !quoting && !quoteError) { setSheet(null); navigate(`${base}/confirm`); } };
  const save = async () => {
    if (saving || !quote || !desiredDate) return; setSaving(true); setError(null);
    try {
      const body = { shipping_address_id: addressId, desired_delivery_date: desiredDate, items, note, ...(orderId ? { version: lock?.version ?? initialOrder?.version } : { request_id: requestId.current }) };
      const result = await api(orderId ? `/api/customer/orders/${orderId}` : '/api/customer/orders', { method: orderId ? 'PUT' : 'POST', body: JSON.stringify(body) });
      locked.current = false; setComplete(result); navigate(`${base}/complete`, { replace: true });
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };
  if (loading) return <Loading label={orderId ? '注文内容を準備しています' : 'お取引先専用の商品を読み込んでいます'} />;
  if (error && !products.length || error && orderId && !lock) return <><Heading title="ご注文を準備できませんでした" eyebrow="ORDER" back={orderId ? `/orders/${orderId}` : undefined} /><InlineError message={error!} retry={() => setReload((value) => value + 1)} /></>;
  if (complete) return <><Heading title={orderId ? '変更を受け付けました' : 'ご注文を受け付けました'} eyebrow={orderId ? 'ORDER UPDATED' : 'THANK YOU'} /><div className="ko-panel ko-success"><div className="ko-success-icon"><Check size={34} /></div><div className="ko-receipt"><span>注文番号</span><strong>{complete.order_number || complete.id}</strong><span>受付日時</span><strong>{formatDate(complete.ordered_at || complete.updated_at || complete.created_at, true)}</strong><span>到着希望日</span><strong>{formatDate(complete.desired_delivery_date || desiredDate)}</strong>{orderId && <><span>改訂番号</span><strong>rev.{complete.revision_no || complete.version || (initialOrder?.version || 1) + 1}</strong></>}</div><p className="ko-muted">受付内容は注文履歴からご確認いただけます。</p><Link className="ko-button" to={`/orders/${complete.id || orderId}`}>注文内容を確認する <ChevronRight size={18} /></Link><Link className="ko-text-link" to="/orders">注文履歴へ</Link></div></>;
  if (!addresses.length) return <Unavailable title="配送先の登録が必要です" message="ご注文の前に配送先を登録する必要があります。小島醸造へ配送先の登録をご依頼ください。" />;
  return <div className={`ko-order-page${confirming ? '' : ' has-cart'}`}>
    <Heading title={confirming ? (orderId ? '変更内容の確認' : 'ご注文内容の確認') : orderId ? 'ご注文の変更' : 'ご注文'} eyebrow={confirming ? 'CONFIRM YOUR ORDER' : 'ORDER'} back={confirming ? base : orderId ? `/orders/${orderId}` : undefined}><span className="ko-company">{actor.company_name || actor.name} 様</span></Heading>
    {location.state?.notice && <div className="ko-notice" role="status"><CheckCircle2 size={18} /><span>{location.state.notice}</span></div>}
    {orderId && <div className="ko-notice"><ShieldCheck size={18} /><span>注文済み商品の単価は維持されます。{lock?.expires_at && <>編集期限 {new Date(lock.expires_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}（操作中は自動更新）</>}</span></div>}
    {error && <InlineError message={error} />}
    {confirming ? <>
      <div className="ko-stepper"><span className="done"><Check size={12} /> 商品を選ぶ</span><i /><span className="current">2 内容を確認</span><i /><span>3 完了</span></div>
      <div className="ko-panel"><h2 className="ko-section-title"><MapPin size={18} /> お届け先</h2><strong>{addressName(address)}</strong><p className="ko-muted">〒{address?.postal_code} {addressText(address)}<br />{address?.phone}</p><div className="ko-delivery-date"><CalendarDays size={20} /><div><small>到着希望日</small><strong>{formatDate(desiredDate)}</strong></div></div>{orderId && initialOrder?.desired_delivery_date !== desiredDate && <p className="ko-comparison">変更前：{formatDate(initialOrder.desired_delivery_date)}</p>}</div>
      <div className="ko-panel"><h2 className="ko-section-title">ご注文商品 <small>{totalQty}本</small></h2>{items.map((item) => { const product = products.find((value) => value.id === item.product_id); const previous = initialOrder?.items?.find((value: any) => value.product_id === item.product_id); return <div className="ko-confirm-item" key={item.product_id}><div><strong>{product ? productName(product) : item.product_id}</strong><small>{product?.volume_ml || product?.capacity_ml}ml / {money(product?.unit_price)} × {item.quantity}本</small>{previous && previous.quantity !== item.quantity && <span className="ko-comparison">数量 {previous.quantity}本 → {item.quantity}本</span>}</div><strong>{money(Number(product?.unit_price || 0) * item.quantity)}</strong></div>; })}{initialOrder?.items?.filter((item: any) => !items.some((next) => next.product_id === item.product_id)).map((item: any) => <div className="ko-confirm-item ko-comparison" key={item.product_id}>{item.snap_product_name || item.product_name || item.name}：{item.quantity}本 → 削除</div>)}</div>
      {quote && <div className="ko-panel"><QuoteSummary quote={quote} />{orderId && <div className="ko-price-comparison"><span>変更前 {money(initialOrder.total_amount)}</span><ArrowRight size={16} /><strong>変更後 {money(quote.total_amount)}</strong></div>}</div>}
      {note && <div className="ko-panel"><h2 className="ko-section-title">ご要望・備考</h2><p className="ko-preline">{note}</p></div>}
      {quoteError && <InlineError message={quoteError} />}<p className="ko-legal"><ShieldCheck size={15} />下記のボタンで{orderId ? '変更が' : 'ご注文が'}確定します。連続して押す必要はありません。</p>
      <button className="ko-button" disabled={saving || quoting || !quote || !desiredDate || !!quoteError || (orderId ? !locked.current : false)} onClick={() => void save()}>{saving ? <><LoaderCircle className="ko-spin" size={19} />受付処理中…</> : <>{orderId ? '変更を確定する' : '注文を確定する'}<ArrowRight size={19} /></>}</button><button className="ko-button secondary" onClick={() => navigate(base)} disabled={saving}>商品選択に戻る</button>
    </> : <>
      <button className="ko-address-bar" onClick={() => setSheet('address')}><MapPin size={21} /><span><small>お届け先</small><strong>{addressName(address)}</strong></span><span className="ko-address-change">変更 <ChevronRight size={16} /></span></button>
      <p className="ko-order-intro">商品と数量を選び、カートで配送日をご指定ください。</p>
      <label className="ko-search"><Search size={18} /><input aria-label="商品を検索" placeholder="商品名から探す" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="検索をクリア" onClick={() => setQuery('')}><X size={16} /></button>}</label>
      {categories.length > 1 && <div className="ko-filters"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>すべて</button>{categories.map((category) => <button className={filter === category ? 'active' : ''} key={category} onClick={() => setFilter(category)}>{category}</button>)}</div>}
      <div className="ko-catalog-caption"><span>商品一覧</span><small>{visible.length} 商品 / 価格はすべて税抜</small></div>
      {visible.length === 0 ? <Empty icon={Search} title={products.length ? '該当する商品はありません' : '現在ご注文いただける商品はありません'}>条件を変更するか、小島醸造までお問い合わせください。</Empty> : <div className="ko-order-products">{visible.map((product) => { const unavailable = product.unit_price == null || product.is_available === false || product.is_available === 0 || (product.sales_status ? product.sales_status !== 'on_sale' : ['stopped', 'unavailable', 'inactive'].includes(product.status || '')); return <article className={`ko-order-product${quantities[product.id] ? ' selected' : ''}`} key={product.id}><Link to={`/products/${product.id}`} tabIndex={-1} aria-label={`${productName(product)}の紹介`}><Bottle product={product} /></Link><div className="ko-order-product-content"><span className="ko-product-category">{product.category || '小島醸造'}{product.is_limited ? <em>お取引先限定</em> : null}</span><Link to={`/products/${product.id}`} className="ko-product-name">{productName(product)}</Link>{(product.short_description || product.description) && <p className="ko-product-description">{product.short_description || product.description}</p>}<span className="ko-product-volume">{product.volume_ml || product.capacity_ml}ml</span><div className="ko-product-bottom"><div className="ko-product-price">{unavailable ? <span className="ko-unavailable-label">現在注文できません</span> : <><strong>{money(product.unit_price)}</strong><small> / {product.unit || '本'}（税抜）</small></>}</div><Quantity value={quantities[product.id] || 0} disabled={unavailable} onChange={(value) => setQuantity(product.id, value)} label={`${productName(product)} ${product.volume_ml || product.capacity_ml || ''}ml`} /></div></div></article>; })}</div>}
      <p className="ko-order-assurance">送料と合計はカートで確認できます。</p>
      <div className="ko-cart-bar"><div><span><ShoppingBag size={17} /> {items.length}商品 <b>{totalQty}本</b></span><strong>{money(subtotal)}<small> 税抜小計</small></strong></div><button className="ko-button" disabled={!items.length} onClick={() => setSheet('cart')}>カートを見る <ChevronRight size={19} /></button></div>
    </>}
    {sheet === 'address' && <Modal title="配送先を選択" onClose={() => setSheet(null)}><p className="ko-muted">配送先に合わせて送料とお届け可能日を確認します。</p><div className="ko-address-options">{addresses.map((candidate) => <button key={candidate.id} className={`ko-address-option${addressId === candidate.id ? ' active' : ''}`} onClick={() => { setAddressId(candidate.id); setDesiredDate(''); setSheet(null); }}><span className="ko-radio">{addressId === candidate.id && <span />}</span><span><strong>{addressName(candidate)} {candidate.is_default ? <em>既定</em> : null}</strong><small>〒{candidate.postal_code} {addressText(candidate)}</small><small>{candidate.phone}</small></span></button>)}</div><p className="ko-footnote">配送先の追加・変更は小島醸造へご依頼ください。</p></Modal>}
    {sheet === 'calendar' && <Modal title="到着希望日を選択" onClose={() => setSheet('cart')}><p className="ko-muted">配送ルール・営業日を確認した、お届け可能日のみ表示しています。</p>{dates.length ? <div className="ko-date-options">{dates.map((date) => <button className={date === desiredDate ? 'active' : ''} onClick={() => { setDesiredDate(date); setSheet('cart'); }} key={date}><CalendarDays size={18} /><span>{formatDate(date)}</span>{date === desiredDate && <Check size={17} />}</button>)}</div> : <Empty icon={CalendarDays} title="現在選べる配送日がありません">小島醸造にお問い合わせください。</Empty>}</Modal>}
    {sheet === 'cart' && <Modal title="カート" onClose={() => setSheet(null)}>{items.length ? <><div className="ko-cart-items">{items.map((item) => { const product = products.find((value) => value.id === item.product_id); return <div className="ko-cart-item" key={item.product_id}><div><strong>{product ? productName(product) : item.product_id}</strong><small>{product?.volume_ml || product?.capacity_ml}ml / {money(product?.unit_price)}（税抜）</small><button className="ko-remove" onClick={() => setQuantity(item.product_id, 0)}>削除</button></div><div><strong>{money(Number(product?.unit_price || 0) * item.quantity)}</strong><Quantity value={item.quantity} onChange={(value) => setQuantity(item.product_id, value)} /></div></div>; })}</div><button className="ko-sheet-address" onClick={() => setSheet('address')}><MapPin size={18} /><span>{addressName(address)}</span><small>変更</small><ChevronRight size={15} /></button>{quoting ? <Loading label="送料と合計を計算しています" /> : quote && <QuoteSummary quote={quote} />}{quoteError && <InlineError message={quoteError} />}<label className="ko-label">到着希望日 <em>必須</em></label><button className={`ko-date-select${!desiredDate ? ' placeholder' : ''}`} onClick={() => setSheet('calendar')}><CalendarDays size={20} /><span>{desiredDate ? formatDate(desiredDate) : 'お届け可能日から選択してください'}</span><ChevronRight size={18} /></button><label className="ko-label" htmlFor="ko-note">ご要望・備考 <small>任意</small></label><textarea id="ko-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="お届けについてのご要望など" rows={2} /><button className="ko-button" disabled={!desiredDate || !quote || quoting || !!quoteError} onClick={confirm}>{orderId ? '変更内容を確認する' : '注文内容を確認する'} <ArrowRight size={18} /></button></> : <Empty title="カートは空です">商品一覧から商品をお選びください。</Empty>}</Modal>}
  </div>;
}

function QuoteSummary({ quote }: { quote: Quote }) {
  return <div className="ko-quote"><div className="ko-packaging"><Truck size={18} /><span>{quote.shipping_fee === 0 ? '自社便・送料無料' : 'ヤマト運輸 宅急便'}{quote.packages?.length ? <small><Package size={13} /> {quote.packages.reduce((sum: number, item: any) => sum + Number(item.quantity || item.count || 1), 0)}個口 {quote.packages.map((item: any) => item.size_code || item.size || item.size_name || item.box_name).filter(Boolean).join('・')}</small> : null}</span></div><dl><div><dt>商品小計（税抜）</dt><dd>{money(quote.items_subtotal)}</dd></div><div><dt>配送料（税抜）</dt><dd>{quote.shipping_fee === 0 ? '無料' : money(quote.shipping_fee)}</dd></div><div><dt>消費税{quote.is_reference_tax ? '（参考税額）' : ''}</dt><dd>{money(quote.tax_amount)}</dd></div><div className="ko-total"><dt>税込合計</dt><dd>{money(quote.total_amount)}</dd></div></dl>{quote.is_reference_tax && <p className="ko-footnote">消費税は参考税額です。正式な税額は請求書発行時に請求単位で計算します。</p>}</div>;
}

function OrderHistory() {
  const [filter, setFilter] = useState('all'); const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useResource<{ data: any[]; meta: { total: number; page: number; page_size: number } }>(`/api/customer/orders?page=${page}&page_size=20${filter === 'all' ? '' : `&status=${encodeURIComponent(filter)}`}`, true);
  const filtered = data?.data || [];
  const pages = Math.max(1, Math.ceil((data?.meta.total || 0) / 20));
  return <><Heading title="注文履歴" eyebrow="YOUR ORDERS" /><p className="ko-page-description">同じお取引先のご注文を、担当者みなさまで確認できます。</p><div className="ko-filters">{[['all', 'すべて'], ...Object.entries(statuses).filter(([key]) => key !== 'shipping')].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => { setFilter(value); setPage(1); }}>{label}</button>)}</div>{loading ? <Loading /> : error ? <InlineError message={error.message} retry={reload} /> : !filtered.length ? <div className="ko-panel"><Empty icon={ClipboardList} title="ご注文はありません">{filter === 'all' ? '初めてのご注文をお待ちしています。' : '選択したステータスのご注文はありません。'}</Empty><Link className="ko-button secondary" to="/order">商品を選ぶ <ArrowRight size={17} /></Link></div> : <div className="ko-order-history">{filtered.map((order: any) => <Link to={`/orders/${order.id}`} key={order.id} className="ko-history-card"><div className="ko-history-top"><span>{formatDate(order.ordered_at || order.created_at)}</span><Status status={order.status} /></div><h2>{order.order_number || order.id}</h2><div className="ko-history-delivery"><CalendarDays size={16} /><span>到着希望日 {formatDate(order.desired_delivery_date)}</span></div><div className="ko-history-bottom"><small>{order.item_count != null ? `${order.item_count}商品` : 'ご注文合計'}{order.staff_name ? ` / ${order.staff_name} 様` : ''}</small><strong>{money(order.total_amount)} <ChevronRight size={18} /></strong></div></Link>)}</div>}{!loading && !error && pages > 1 && <div className="ko-pagination"><button disabled={page === 1} onClick={() => setPage((value) => value - 1)}><ArrowLeft size={15} />前へ</button><span>{page} / {pages}</span><button disabled={page === pages} onClick={() => setPage((value) => value + 1)}>次へ<ArrowRight size={15} /></button></div>}</>;
}

function OrderDetail() {
  const { id } = useParams(); const navigate = useNavigate();
  const { data: order, loading, error, reload } = useResource<any>(`/api/customer/orders/${id}`);
  const [cancelling, setCancelling] = useState(false); const [busy, setBusy] = useState(false); const [actionError, setActionError] = useState<string | null>(null); const [reason, setReason] = useState('');
  const cancel = async () => { if (busy || !reason.trim()) return; setBusy(true); setActionError(null); try { await api(`/api/customer/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ version: order.version, reason }) }); setCancelling(false); reload(); } catch (err) { setActionError((err as Error).message); } finally { setBusy(false); } };
  if (loading) return <Loading />; if (error) return <><Heading title="ご注文の詳細" eyebrow="ORDER DETAIL" back="/orders" /><InlineError message={error.message} retry={reload} /></>; if (!order) return null;
  const address = typeof order.shipping_address === 'string' ? (() => { try { return JSON.parse(order.shipping_address); } catch { return null; } })() : order.shipping_address || order.shipping_address_snapshot || order.address || { name: order.snap_recipient_name, postal_code: order.snap_postal_code, address: order.snap_address, phone: order.snap_phone };
  return <><Heading title="ご注文の詳細" eyebrow="ORDER DETAIL" back="/orders"><Status status={order.status} /></Heading><div className="ko-detail-number"><h2>{order.order_number || order.id}</h2><p>ご注文日時 {formatDate(order.ordered_at || order.created_at, true)}</p>{order.updated_at && <p>最終更新 {formatDate(order.updated_at, true)}</p>}<p>ご担当者 {order.staff_name || order.ordered_by_name || '—'} 様</p></div><div className="ko-panel"><h2 className="ko-section-title"><MapPin size={18} /> お届け先</h2><strong>{addressName(address)}</strong><p className="ko-muted">{address?.postal_code && `〒${address.postal_code} `}{addressText(address)}<br />{address?.phone}</p><div className="ko-delivery-date"><CalendarDays size={21} /><div><small>到着希望日</small><strong>{formatDate(order.desired_delivery_date)}</strong></div></div></div><div className="ko-panel"><h2 className="ko-section-title">ご注文商品</h2>{order.items?.map((item: any) => <div className="ko-confirm-item" key={item.product_id || item.id}><div><strong>{item.snap_product_name || item.product_name || item.name}</strong><small>{item.snap_volume_ml || item.volume_ml ? `${item.snap_volume_ml || item.volume_ml}ml / ` : ''}{money(item.unit_price)} × {item.quantity}{item.snap_unit || item.unit || '本'}</small></div><strong>{money(item.line_total ?? item.subtotal ?? item.unit_price * item.quantity)}</strong></div>)}<QuoteSummary quote={{ ...order, is_reference_tax: order.snap_tax_calc_unit === 'invoice' }} /></div>{order.note && <div className="ko-panel"><h2 className="ko-section-title">ご要望・備考</h2><p className="ko-preline">{order.note}</p></div>}<div className="ko-notice"><Clock size={18} /><span>{order.can_edit ? <>変更・キャンセル期限<br /><strong>{formatDate(order.edit_deadline, true)}</strong></> : order.status === 'cancelled' ? 'この注文はキャンセル済みです。' : order.is_invoice_locked ? '請求書発行済みのため、変更・キャンセルはできません。' : '変更期限または配送状況により、変更・キャンセルはできません。'}</span></div>{order.can_edit && <><button className="ko-button" onClick={() => navigate(`/orders/${id}/edit`)}>注文内容を編集 <ArrowRight size={18} /></button><button className="ko-button danger-quiet" onClick={() => setCancelling(true)}>注文をキャンセル</button></>}{order.revisions?.length > 0 && <details className="ko-revisions"><summary>変更履歴（{order.revisions.length}件）</summary>{order.revisions.map((revision: any) => <div key={revision.id || revision.revision_no}><strong>rev.{revision.revision_no || revision.revision || revision.version}</strong><span>{formatDate(revision.changed_at || revision.created_at, true)}</span><span>{money(revision.total_amount || revision.after_total)}</span></div>)}</details>}{cancelling && <Modal title="注文のキャンセル" onClose={() => { if (!busy) setCancelling(false); }}><div className="ko-cancel-warning"><AlertCircle size={25} /><h3>このご注文をキャンセルしますか？</h3><p>{order.order_number}<br />{money(order.total_amount)}（税込）</p></div><p className="ko-muted">確定後は元に戻せません。再度ご注文いただく場合は商品選択からお手続きください。</p><label className="ko-label" htmlFor="cancel-reason">キャンセル理由 <em>必須</em></label><textarea id="cancel-reason" required value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} />{actionError && <InlineError message={actionError} />}<button className="ko-button danger" onClick={() => void cancel()} disabled={busy || !reason.trim()}>{busy ? <LoaderCircle className="ko-spin" size={18} /> : 'キャンセルを確定する'}</button><button className="ko-button secondary" onClick={() => setCancelling(false)} disabled={busy}>ご注文を残す</button></Modal>}</>;
}

function ProductList() {
  const { actor } = useAuth();
  const { data, loading, error, reload } = useResource<Product[]>(actor?.type === 'customer' ? '/api/customer/catalog' : '/api/public/products');
  return <><Heading title="商品紹介" />{loading ? <Loading /> : error ? <InlineError message={error.message} retry={reload} /> : !data?.length ? <Empty icon={Wine} title="商品情報を準備しています" /> : <div className="ko-public-products">{data.map((product) => <Link to={`/products/${product.id}`} className="ko-public-product" key={product.id}><Bottle product={product} large /><div><span className="ko-product-category">{product.category}</span><h2>{productName(product)}</h2><p>{product.short_description}</p><span className="ko-product-volume">{product.volume_ml || product.capacity_ml}ml</span><span className="ko-product-more">詳しく見る <ArrowRight size={17} /></span></div></Link>)}</div>}<p className="ko-footnote ko-age-note">お酒は20歳になってから。飲酒運転は法律で禁止されています。</p></>;
}
function ProductDetail() {
  const { id } = useParams();
  const { actor } = useAuth();
  const { data: products, loading, error, reload } = useResource<Product[]>(actor?.type === 'customer' ? '/api/customer/catalog' : '/api/public/products');
  const product = products?.find((value) => value.id === id);
  if (loading) return <Loading />; if (error) return <InlineError message={error.message} retry={reload} />;
  if (!product) return <Unavailable title="商品が見つかりません" message="商品情報が変更された可能性があります。商品紹介一覧をご確認ください。" />;
  return <><Heading title={productName(product)} eyebrow="THE STORY OF OUR SAKE" back="/products" /><div className="ko-product-detail-hero"><Bottle product={product} large /><div><span className="ko-product-category">{product.category}</span><h2>{product.short_description || productName(product)}</h2><p>{product.volume_ml || product.capacity_ml}ml</p></div></div><div className="ko-story-grid">{[{ title: '商品説明', text: product.description }, { title: 'こだわり', text: product.commitment }, { title: '味わい', text: product.taste }, { title: 'おすすめの飲み方', text: product.recommended_way }].map((section) => <section className="ko-story" key={section.title}><h2>{section.title}</h2><p>{section.text || '詳しい商品情報については、お気軽に小島醸造へお問い合わせください。'}</p></section>)}</div><Link to="/order" className="ko-button">この商品を注文画面で見る <ArrowRight size={18} /></Link><p className="ko-footnote ko-age-note">お酒は20歳になってから。飲酒運転は法律で禁止されています。</p></>;
}
function Contact() {
  const { data, loading, error, reload } = useResource<any>('/api/public/contact');
  const phone = data?.phone || data?.tel || data?.contact_phone; const email = data?.email || data?.contact_email;
  return <><Heading title="お問い合わせ" eyebrow="CONTACT US" /><p className="ko-page-description">ご注文や商品について、<br />どうぞお気軽にお問い合わせください。</p>{loading ? <Loading /> : error ? <InlineError message={error.message} retry={reload} /> : <><div className="ko-contact-card"><Phone size={26} strokeWidth={1.4} /><h2>お電話でのお問い合わせ</h2>{phone ? <><a className="ko-phone-number" href={`tel:${phone}`}>{phone}</a><a className="ko-button" href={`tel:${phone}`}><Phone size={18} />電話をかける</a></> : <p className="ko-muted">電話番号は現在準備中です。</p>}<p className="ko-contact-hours"><Clock size={15} />{data?.hours || data?.business_hours || data?.contact_hours || '受付時間はお問い合わせください'}</p></div><div className="ko-contact-card"><Mail size={26} strokeWidth={1.4} /><h2>メールでのお問い合わせ</h2>{email ? <><a href={`mailto:${email}`} className="ko-email">{email}</a><a className="ko-button secondary" href={`mailto:${email}`}>メールを作成する <ArrowRight size={17} /></a></> : <p className="ko-muted">メールアドレスは現在準備中です。</p>}</div>{(data?.note || data?.contact_note || data?.message) && <div className="ko-notice"><MessageCircle size={18} /><p className="ko-preline">{data.note || data.contact_note || data.message}</p></div>}</>}</>;
}

function Invite() {
  const [search] = useSearchParams(); const token = search.get('t'); const { actor, lineReady, lineAuthenticated, lineProfile, config, login, refresh, error: authError, loading: authLoading } = useAuth(); const navigate = useNavigate();
  const identityScope = JSON.stringify([actor?.type ?? null, actor?.id ?? null, actor?.company_id ?? null, lineAuthenticated]);
  const { data: invitation, loading, error, reload } = useResource<any>(!authLoading && token ? `/api/public/invitations/lookup?t=${encodeURIComponent(token)}` : null, false, identityScope);
  const [staffName, setStaffName] = useState(''); const [busy, setBusy] = useState(false); const [submitError, setSubmitError] = useState<string | null>(null); const [canRetryLineAuth, setCanRetryLineAuth] = useState(false); const [registered, setRegistered] = useState(false);
  useEffect(() => { if (lineProfile?.displayName && !staffName) setStaffName(lineProfile.displayName); }, [lineProfile]);
  const companyId = invitation?.company_id || invitation?.company?.id;
  const companyName = invitation?.company_name || invitation?.company?.name || invitation?.company?.company_name || 'お取引先';
  // Lookup may see an old browser cookie when LIFF has no usable credentials.
  // Its account-specific flags are valid only for the freshly resolved customer.
  const alreadyRegistered = actor?.type === 'customer' && invitation?.already_registered;
  const differentCompany = actor?.type === 'customer' && invitation?.different_company;
  useEffect(() => { if (!authLoading && !loading && (alreadyRegistered || (actor?.type === 'customer' && companyId && actor.company_id === companyId)) && !registered) navigate('/order', { replace: true, state: { notice: `すでに${companyName}として登録済みです` } }); }, [actor, authLoading, loading, companyId, companyName, navigate, registered, alreadyRegistered]);
  const register = async () => {
    if (!staffName.trim() || busy || !token) return; setBusy(true); setSubmitError(null); setCanRetryLineAuth(false);
    try { const credentials = lineCredentials(); if (!credentials) throw new Error(lineCredentialError); await api('/api/public/invitations/register', { method: 'POST', body: JSON.stringify({ token, staff_name: staffName.trim(), ...credentials }) }); setRegistered(true); await refresh(); navigate(`/invite/complete?t=${encodeURIComponent(token)}`, { replace: true }); }
    catch (err) { setSubmitError((err as Error).message); setCanRetryLineAuth((err instanceof ApiError && [401,403].includes(err.status)) || (err as Error).message === lineCredentialError); } finally { setBusy(false); }
  };
  if (loading || authLoading) return <Loading label="招待内容を確認しています" />;
  if (!token) return <Unavailable title="招待QRコードからご登録ください" message="お取引先へお渡しした招待QRコードを読み取ると、登録を開始できます。" />;
  if (error) return <><Heading title="招待状をご確認ください" eyebrow="INVITATION" /><InlineError message={error.message} retry={reload} /><p className="ko-muted">有効期限切れ・登録人数上限・無効化などで登録できない場合は、小島醸造に新しい招待状をご依頼ください。</p><Link to="/contact" className="ko-button secondary">お問い合わせ <ChevronRight size={18} /></Link></>;
  if (differentCompany || (actor?.type === 'customer' && companyId && actor.company_id !== companyId)) return <Unavailable title="別のお取引先で登録されています" message="このLINEアカウントは、すでに別のお取引先に登録されています。所属の変更は小島醸造へご依頼ください。" />;
  if (invitation?.full && lineAuthenticated && !alreadyRegistered && !registered) return <Unavailable title="招待の登録人数が上限に達しています" message="この招待状で登録できる人数が上限に達しました。小島醸造に招待状の更新をご依頼ください。" />;
  if (registered) return <><Heading title="登録が完了しました" eyebrow="WELCOME" /><div className="ko-panel ko-success"><div className="ko-success-icon"><CheckCircle2 size={35} /></div><h2>{companyName}<br />{staffName} 様</h2><p>LINEの下部メニューから、<br />いつでもご注文いただけます。</p><Link className="ko-button" to="/order">続けて注文する <ArrowRight size={18} /></Link>{lineReady && liff.isInClient() && <button className="ko-button secondary" onClick={() => liff.closeWindow()}>閉じる</button>}</div></>;
  return <><Heading title="お取引先のご登録" eyebrow="WELCOME TO KOJIMA BREWERY" /><div className="ko-invitation-brand"><h2>{companyName} 様</h2></div><div className="ko-panel"><h2 className="ko-section-title">注文ご担当者の登録</h2><p className="ko-muted">このLINEアカウントを、{companyName}の注文ご担当者として登録します。</p>{!lineAuthenticated ? <>{authError && <InlineError message={authError} />}{lineReady ? <button className="ko-button ko-line-button" onClick={login}>{authError ? 'LINEの認証をやり直す' : 'LINEでログインして登録'} <ArrowRight size={18} /></button> : <InlineError message={config?.liff_id ? 'LINEへの接続を確認できませんでした。LINE内で招待URLを開き直してください。' : 'LINE連携が未設定です。小島醸造に設定状況をお問い合わせください。'} />}</> : <form onSubmit={(event) => { event.preventDefault(); void register(); }}><label htmlFor="staff-name" className="ko-label">ご担当者名 <em>必須</em></label><input id="staff-name" required autoComplete="name" value={staffName} onChange={(event) => setStaffName(event.target.value)} maxLength={100} placeholder="山田 太郎" /><p className="ko-footnote">{lineProfile?.displayName ? 'LINE表示名を初期表示しています。ご担当者の氏名に変更してください。' : 'ご担当者の氏名を入力してください。'}</p>{submitError && <InlineError message={submitError} />}{canRetryLineAuth && <button type="button" className="ko-text-link" onClick={login}>LINEの認証をやり直す</button>}<button className="ko-button" type="submit" disabled={!staffName.trim() || busy}>{busy ? <LoaderCircle className="ko-spin" size={19} /> : <>登録する <ArrowRight size={18} /></>}</button></form>}</div><p className="ko-legal"><ShieldCheck size={16} />LINEアカウントとお取引先情報を安全に連携します。</p></>;
}
