import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Search, Plus, ArrowLeft, Building2, MapPin, QrCode, Tag, FileText,
  Pencil, Save, Copy, Printer, CircleCheck, Trash2, Users,
} from 'lucide-react';
import QRCode from 'qrcode';
import { api, apiRaw, money, date } from './api';
import {
  Badge, Loading, Empty, ErrorBox, Modal, Pagination, ConfirmDialog,
  FieldHelp, useRowNavigation, navigableRowProps,
} from './ui';

type Row = Record<string, any>;
type Field = {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: [string, string][];
  wide?: boolean;
  placeholder?: string;
  help: string;
  min?: number;
  max?: number;
};
type EntityType = 'company' | 'addresses' | 'contracts' | 'invitations' | 'price' | 'price-history' | 'line-user';
type Editor = { type: EntityType; row: Row };
type Action = { type: 'prices' | 'revoke' | 'unlink' | 'delete'; row?: Row; entity?: EntityType };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const dateFieldValue = (value: unknown) => {
  const text = String(value || '');
  if (!text || /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(parsed);
};
const activeOptions: [string, string][] = [['active', '有効'], ['inactive', '無効']];

const companyFields: Field[] = [
  { key: 'name', label: '会社名・屋号', required: true, wide: true, placeholder: '例：株式会社 小島酒店', help: '取引先一覧や請求書に表示する正式な会社名・屋号です。' },
  { key: 'contact_name', label: '担当窓口名', placeholder: '例：山田 太郎', help: '小島醸造からの連絡を受けるご担当者のお名前です。LINE登録の担当者名とは別に管理します。' },
  { key: 'phone', label: '電話番号', type: 'tel', placeholder: '例：0568-00-0000', help: '取引先の代表または担当窓口につながる電話番号です。' },
  { key: 'postal_code', label: '郵便番号', placeholder: '例：484-0081', help: '取引先の所在地の郵便番号です。ハイフンを含めて入力できます。' },
  { key: 'address', label: '住所', wide: true, placeholder: '例：愛知県犬山市犬山東古券633', help: '取引先の所在地です。実際のお届け先は「配送先」で別途登録します。' },
  { key: 'status', label: '状態', type: 'select', options: activeOptions, help: '「無効」にすると、この取引先のLINE注文を停止します。過去の注文・請求履歴は残ります。' },
  { key: 'note', label: '備考', type: 'textarea', wide: true, placeholder: '例：連絡は平日10時〜17時。請求書は本社宛て。', help: '社内向けの補足事項を記録します。秘密情報や認証用の値は記載しないでください。' },
];
const addressFields: Field[] = [
  { key: 'name', label: '配送先名', required: true, wide: true, placeholder: '例：本店・名古屋支店・物流倉庫', help: '注文画面でお客さまが選ぶ配送先の名前です。店舗・支店・倉庫ごとに登録できます。' },
  { key: 'postal_code', label: '郵便番号', required: true, placeholder: '例：484-0081', help: '配送先の郵便番号です。送り状や納品書で使用します。' },
  { key: 'prefecture', label: '都道府県', required: true, placeholder: '例：愛知県', help: 'ヤマト運輸の配送地域・送料判定に使用します。都・道・府・県まで入力してください。' },
  { key: 'city', label: '市区町村', required: true, placeholder: '例：犬山市', help: '自社配達の対象地域を判定します。町域・番地は次の欄に入力してください。' },
  { key: 'address_line1', label: '町域・番地', required: true, placeholder: '例：犬山東古券633', help: '町名・大字・番地など、市区町村以降の住所を入力します。' },
  { key: 'address_line2', label: '建物名・部屋番号', wide: true, placeholder: '例：小島ビル1階・101号室', help: '建物名、階数、部屋番号などがある場合に入力します。該当しなければ空欄で保存できます。' },
  { key: 'phone', label: '電話番号', type: 'tel', required: true, placeholder: '例：0568-00-0000', help: '配達時に連絡が取れる配送先の電話番号です。' },
  { key: 'contact_name', label: '配送先担当者名', placeholder: '例：山田 花子', help: '商品の受け取りを担当する方のお名前です。' },
  { key: 'is_default', label: '既定の配送先にする', type: 'checkbox', help: '注文画面を開いたときに最初に選ばれる配送先です。同じ取引先で1件のみ設定できます。' },
  { key: 'shipping_rule_id', label: '適用配送ルール', type: 'select', help: '「自動判定」では住所に応じた配送方法を選びます。個別の契約がある場合は該当するルールを指定します。' },
  { key: 'status', label: '状態', type: 'select', options: activeOptions, help: '「無効」の配送先は、新しいLINE注文の配送先一覧に表示されません。' },
  { key: 'note', label: '備考', type: 'textarea', wide: true, placeholder: '例：裏口から搬入。火曜日は受け取り不可。', help: '配送先について管理者が確認する補足事項です。' },
];
const contractFields: Field[] = [
  { key: 'contract_name', label: '契約名', required: true, wide: true, placeholder: '例：2026年度 卸売基本契約', help: '取引条件を識別する名前です。取引先ごとに契約期間と請求条件を管理します。' },
  { key: 'start_date', label: '開始日', type: 'date', help: '契約の適用を開始する日です。未定の場合は空欄で保存できます。' },
  { key: 'end_date', label: '終了日', type: 'date', help: '期限を設けない契約は空欄にします。指定する場合は開始日以降の日付にしてください。' },
  { key: 'closing_day', label: '締日', type: 'number', required: true, min: 1, max: 31, placeholder: '例：31（月末締め）', help: '請求を締める日を1〜31で指定します。31は月末を表します。' },
  { key: 'payment_terms', label: '支払条件', wide: true, placeholder: '例：月末締め・翌月末払い', help: '請求担当者が確認する支払条件です。請求書発行時に支払期日を確認してください。' },
  { key: 'status', label: '状態', type: 'select', options: activeOptions, help: '「無効」にすると新しい注文への契約の自動適用を停止します。過去の履歴は残ります。' },
  { key: 'note', label: '備考', type: 'textarea', wide: true, placeholder: '例：契約書は本社で保管。更新は毎年4月。', help: '契約について管理者が確認する補足事項です。' },
];
const priceFields: Field[] = [
  { key: 'unit_price', label: '専用単価（税抜）', type: 'number', min: 0, max: 10000000, placeholder: '例：2100（空欄は標準卸価格）', help: 'この取引先専用の1本あたりの税抜単価です。空欄かつ取扱可にすると、専用単価を解除して標準卸価格に戻します。' },
  { key: 'is_available', label: 'この商品を取扱可にする', type: 'checkbox', help: 'チェックを外すと、この取引先からの新しい注文を停止します。業者限定商品は取扱可の専用設定がある取引先のみ注文できます。' },
  { key: 'valid_from', label: '適用開始日', type: 'date', required: true, help: '新しい注文にこの単価を適用する最初の日です。すでに受け付けた注文の単価は変わりません。' },
  { key: 'valid_to', label: '適用終了日', type: 'date', help: '指定しない場合は、次の改定まで継続します。開始日以降の日付を指定してください。' },
  { key: 'note', label: '改定の備考', type: 'textarea', wide: true, placeholder: '例：秋季契約単価・2026年10月の価格改定', help: '単価を設定・修正した理由を記録します。' },
];
const savedPriceFields: Field[] = priceFields.map(field => field.key === 'unit_price' ? {
  ...field,
  required: true,
  placeholder: '例：2100',
  help: '保存済み設定の税抜単価です。標準卸価格へ戻す場合は、この専用単価の設定を削除してください。過去に受け付けた注文の単価は変わりません。',
} : field);

export default function Companies() {
  const id = useLocation().pathname.split('/')[3];
  return id ? <CompanyDetail key={id} id={id} /> : <CompanyList />;
}

function CompanyList() {
  const navigate = useNavigate();
  const rowNavigation = useRowNavigation();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    apiRaw<Row[]>(`/api/admin/companies?q=${encodeURIComponent(search)}&status=${status}&page=${page}&page_size=20`)
      .then(result => {
        if (!active) return;
        setRows(result.data); setTotal(result.meta?.total ?? result.data.length);
        if (!result.data.length && page > 1) setPage(current => current - 1);
      })
      .catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [search, status, page, refresh]);

  async function deleteCompany() {
    if (!deleting || saving) return;
    setSaving(true); setError('');
    try {
      await api(`/api/admin/companies/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); setRefresh(value => value + 1);
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  return <>
    <div className="admin-page-head">
      <div><span className="admin-eyebrow">BUSINESS PARTNERS</span><h1>取引先管理</h1><p>お取引先の情報、配送先、LINE登録と販売単価を管理します。</p></div>
      <button className="admin-btn primary" onClick={() => setEditor({ status: 'active' })}><Plus size={18} />取引先を追加</button>
    </div>
    <section className="admin-card">
      <form className="admin-filter-bar" onSubmit={event => { event.preventDefault(); setSearch(q); setPage(1); }}>
        <label className="admin-search"><Search size={18} /><input aria-label="取引先を検索" placeholder="例：小島酒店・山田（会社名・担当者名）" value={q} onChange={event => setQ(event.target.value)} /></label>
        <select className="admin-select" aria-label="状態" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">すべての状態</option><option value="active">有効</option><option value="inactive">無効</option></select>
        <button className="admin-btn primary"><Search size={17} />検索</button><span className="admin-filter-count">{total} 件の取引先</span>
      </form>
      <ErrorBox error={deleting ? '' : error} />
      {busy ? <Loading /> : <>
        <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>会社名・屋号</th><th>担当者</th><th>電話番号</th><th>所在地</th><th>LINE登録</th><th>配送先</th><th>状態</th><th>操作</th></tr></thead>
          <tbody>{rows.map(company => <tr key={company.id} {...rowNavigation(`/admin/companies/${company.id}`, `${company.name}の詳細`)}>
            <td><Link className="admin-company-link" to={`/admin/companies/${company.id}`}><span className="admin-company-avatar"><Building2 size={19} /></span><strong>{company.name}</strong></Link></td>
            <td>{company.contact_name || '—'}</td><td>{company.phone || '—'}</td><td>{company.address || '—'}</td>
            <td>{company.line_user_count ?? company.line_users_count ?? 0} 名</td><td>{company.address_count ?? company.shipping_address_count ?? 0} 件</td><td><Badge value={company.status} /></td>
            <td><div className="admin-inline-actions"><Link className="admin-table-detail" to={`/admin/companies/${company.id}`}>詳細</Link><button className="admin-table-detail" aria-label={`${company.name}を編集`} onClick={() => setEditor(company)}>編集</button><button className="admin-text-danger" aria-label={`${company.name}を削除`} onClick={() => { setError(''); setDeleting(company); }}>削除</button></div></td>
          </tr>)}</tbody>
        </table>{!rows.length && <Empty />}</div>
        <Pagination page={page} total={total} onChange={setPage} />
      </>}
    </section>
    {editor && <EntityForm title={editor.id ? '取引先情報を編集' : '取引先を追加'} fields={companyFields} initial={editor} path={`/api/admin/companies${editor.id ? `/${editor.id}` : ''}`} onClose={() => setEditor(null)} onSaved={company => {
      const wasNew = !editor.id; setEditor(null);
      if (wasNew && company?.id) navigate(`/admin/companies/${company.id}`); else setRefresh(value => value + 1);
    }} onDelete={editor.id ? () => { setDeleting(editor); setEditor(null); setError(''); } : undefined} />}
    <ConfirmDialog open={!!deleting} title="取引先を削除しますか？" busy={saving} onClose={() => { if (!saving) setDeleting(null); }} onConfirm={() => void deleteCompany()}>
      <ErrorBox error={error} /><p><strong>{deleting?.name}</strong>を取引先一覧から削除し、新しい注文・登録を停止します。過去の注文・請求・LINE登録の記録は保持します。</p>
    </ConfirmDialog>
  </>;
}

function CompanyDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const rowNavigation = useRowNavigation();
  const [company, setCompany] = useState<Row | null>(null);
  const [tab, setTab] = useState('basic');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editor | null>(null);
  const [rules, setRules] = useState<Row[]>([]);
  const [products, setProducts] = useState<Row[]>([]);
  const [orders, setOrders] = useState<Row[]>([]);
  const [priceDraft, setPriceDraft] = useState<Record<string, Row>>({});
  const [priceOriginal, setPriceOriginal] = useState<Record<string, Row>>({});
  const [validFrom, setValidFrom] = useState(today());
  const [priceNote, setPriceNote] = useState('');
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState('');
  const [qr, setQr] = useState<Row | null>(null);
  const [qrImage, setQrImage] = useState('');

  async function load() {
    try { const result = await api<Row>(`/api/admin/companies/${id}`); setCompany(result); return result; }
    catch (err) { setError((err as Error).message); return null; }
  }
  useEffect(() => {
    void load();
    api<Row[]>('/api/admin/shipping-rules').then(setRules).catch(err => setError(err.message));
    api<Row[]>('/api/admin/products?page_size=1000').then(setProducts).catch(err => setError(err.message));
    api<Row[]>(`/api/admin/orders?company_id=${id}&page_size=100`).then(setOrders).catch(err => setError(err.message));
  }, [id]);
  useEffect(() => {
    if (!company) return;
    const draft: Record<string, Row> = {};
    for (const product of products) {
      const current = company.prices?.find((price: Row) => price.product_id === product.id && price.status === 'active' && price.valid_from <= today() && (!price.valid_to || price.valid_to >= today()));
      draft[product.id] = { product_id: product.id, unit_price: current?.unit_price ?? '', is_available: current?.is_available ?? (product.is_limited ? 0 : 1) };
    }
    setPriceDraft(draft); setPriceOriginal(draft);
  }, [company, products]);
  useEffect(() => {
    setQrImage('');
    if (!qr?.url) return;
    let active = true;
    QRCode.toDataURL(qr.url, { width: 300, margin: 2, color: { dark: '#142a42', light: '#ffffff' } }).then(image => { if (active) setQrImage(image); }).catch(() => { if (active) setError('QR画像を生成できませんでした。招待URLをコピーしてご利用ください。'); });
    return () => { active = false; };
  }, [qr]);

  const changedPrices = Object.values(priceDraft).filter(row => {
    const previous = priceOriginal[row.product_id];
    return String(row.unit_price) !== String(previous?.unit_price) || Number(row.is_available) !== Number(previous?.is_available);
  });
  const beginEdit = (type: EntityType, row: Row) => { setError(''); setEditing({ type, row }); };
  const beginDelete = (entity: EntityType, row: Row) => { setEditing(null); setError(''); setConfirm({ type: 'delete', entity, row }); };
  const priceName = (row: Row) => row.product_name || products.find(product => product.id === row.product_id)?.name || '商品';
  const deleteName = (action: Action | null) => action?.row?.name || action?.row?.contract_name || (action?.entity === 'price-history' ? priceName(action.row!) : action?.entity === 'invitations' ? 'この招待QRコード' : company?.name);

  async function run() {
    if (!confirm || busy) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      if (confirm.type === 'prices') {
        if (!changedPrices.length) throw new Error('変更された単価設定がありません。');
        if (!validFrom) throw new Error('適用開始日を入力してください。');
        const prices = changedPrices.map(row => ({ ...row, unit_price: row.unit_price === '' ? null : Number(row.unit_price) }));
        await api(`/api/admin/companies/${id}/prices`, { method: 'PUT', body: JSON.stringify({ prices, valid_from: validFrom, note: priceNote }) });
        setSuccess('変更した商品の販売単価を保存しました。');
      } else if (confirm.type === 'revoke') {
        await api(`/api/admin/companies/${id}/invitations/${confirm.row!.id}/revoke`, { method: 'POST', body: '{}' });
        setSuccess('招待QRコードを無効化しました。登録済みのLINE利用者は引き続き利用できます。');
      } else if (confirm.type === 'unlink') {
        await api(`/api/admin/companies/${id}/line-users/${confirm.row!.id}/unlink`, { method: 'POST', body: '{}' });
        setSuccess('LINE利用者の紐付けを解除しました。');
      } else {
        const resource = confirm.entity === 'company' ? '' : confirm.entity === 'price-history' ? `/prices/${confirm.row!.id}` : `/${confirm.entity}/${confirm.row!.id}`;
        await api(`/api/admin/companies/${id}${resource}`, { method: 'DELETE' });
        if (confirm.entity === 'company') { navigate('/admin/companies', { replace: true }); return; }
        setSuccess(confirm.entity === 'invitations' ? '招待QRコードを一覧から削除しました。登録済みのLINE利用者は引き続き利用できます。' : confirm.entity === 'price-history' ? '専用単価を削除しました。過去の注文の単価は変わりません。' : '削除しました。過去の注文・請求の記録は保持します。');
      }
      setConfirm(null); await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  if (!company) return <><ErrorBox error={error} />{!error && <Loading />}</>;
  const tabs = [
    ['basic', '基本情報', Building2], ['addresses', '配送先', MapPin], ['line', 'LINE利用者・招待QR', QrCode],
    ['prices', '販売単価', Tag], ['contracts', '契約・請求条件', FileText], ['orders', '注文履歴', FileText],
  ] as const;
  const activeInvitations = (company.invitations || []).filter((row: Row) => !row.deleted_at);
  const invitationFields: Field[] = [
    { key: 'max_uses', label: '登録可能人数', type: 'number', min: Math.max(1, editing?.row.used_count || 0), max: 10000, placeholder: '例：5（空欄で無制限）', help: 'ひとつのQRコードから登録できる人数です。空欄は無制限です。登録済みの人数より少ない上限には変更できません。' },
    { key: 'expires_at', label: '有効期限', type: 'date', required: true, help: '招待QRから新しく登録できる期限です。指定日の23:59（日本時間）まで有効です。すでに登録したLINE利用者には影響しません。' },
    { key: 'note', label: '備考', type: 'textarea', wide: true, placeholder: '例：店長・発注担当者向けに発行', help: '誰に渡す招待状か、発行目的などを記録します。招待URLやトークンはここに保存しないでください。' },
  ];

  return <>
    <Link className="admin-back-link" to="/admin/companies"><ArrowLeft size={16} />取引先一覧へ戻る</Link>
    <div className="admin-page-head">
      <div><span className="admin-eyebrow">BUSINESS PARTNER DETAIL</span><h1>{company.name}</h1><p>{company.contact_name ? `担当窓口：${company.contact_name}` : '取引先の詳細情報'}</p></div>
      <div className="admin-inline-actions"><Badge value={company.status} /><button className="admin-btn secondary" onClick={() => beginEdit('company', company)}><Pencil size={16} />取引先を編集</button><button className="admin-btn secondary" onClick={() => beginDelete('company', company)}><Trash2 size={16} />取引先を削除</button></div>
    </div>
    <div className="admin-tabs">{tabs.map(([key, label, Icon]) => <button key={key} className={`admin-tab ${tab === key ? 'active' : ''}`} onClick={() => { setTab(key); setError(''); }}><Icon size={17} />{label}</button>)}</div>
    <ErrorBox error={confirm ? '' : error} />
    {success && <div className="admin-alert success" role="status"><CircleCheck size={18} />{success}</div>}

    {tab === 'basic' && <section {...navigableRowProps(() => beginEdit('company', company), `${company.name}の基本情報を編集`)} className="admin-card admin-clickable-row">
      <div className="admin-card-head"><h2>基本情報</h2><button className="admin-btn secondary" onClick={() => beginEdit('company', company)}><Pencil size={16} />編集</button></div>
      <div className="admin-detail-grid">{companyFields.map(field => <div key={field.key} className={field.wide ? 'span-2' : ''}><label>{field.label}</label>{field.key === 'status' ? <Badge value={company.status} /> : <strong>{company[field.key] || '—'}</strong>}</div>)}<div><label>登録日</label><span>{date(company.created_at)}</span></div><div><label>最終更新</label><span>{date(company.updated_at, true)}</span></div></div>
    </section>}

    {tab === 'addresses' && <section className="admin-card">
      <div className="admin-card-head"><div><h2>配送先</h2><span className="admin-muted">店舗・支店・倉庫ごとに登録できます。カードを押すと編集できます。</span></div><button className="admin-btn primary" onClick={() => beginEdit('addresses', { status: 'active', is_default: 0 })}><Plus size={17} />配送先を追加</button></div>
      <div className="admin-address-grid">{company.addresses?.map((address: Row) => <article key={address.id} {...navigableRowProps(() => beginEdit('addresses', address), `${address.name}を編集`)} className="admin-address-card admin-clickable-row">
        <div><span className="admin-small-icon"><MapPin size={20} /></span><h3>{address.name}</h3>{!!address.is_default && <span className="admin-badge confirmed">既定</span>}<Badge value={address.status} /></div>
        <p>〒{address.postal_code}<br />{address.prefecture}{address.city}{address.address_line1}<br />{address.address_line2}</p><span>{address.contact_name || '担当者未登録'} · {address.phone}</span><small>配送ルール：{rules.find(rule => rule.id === address.shipping_rule_id)?.name || '自動判定'}</small>
        <div className="admin-inline-actions"><button className="admin-btn secondary" onClick={() => beginEdit('addresses', address)}><Pencil size={15} />編集する</button><button className="admin-btn secondary" aria-label={`${address.name}を削除`} onClick={() => beginDelete('addresses', address)}><Trash2 size={15} />削除</button></div>
      </article>)}</div>{!company.addresses?.length && <Empty text="配送先が登録されていません" />}
    </section>}

    {tab === 'line' && <>
      <section className="admin-card">
        <div className="admin-card-head"><div><h2>LINE招待QRコード</h2><span className="admin-muted">ひとつのQRコードから、複数の担当者を招待できます</span></div><button className="admin-btn primary" onClick={() => beginEdit('invitations', { max_uses: 5, expires_at: dateFieldValue(new Date(Date.now() + 30 * 86400000).toISOString()), status: 'active' })}><Plus size={17} />招待QRを発行</button></div>
        <div className="admin-info-text">招待URLは発行直後にのみ表示されます。発行時にQR案内状を印刷・保存してください。無効化は新しい登録を停止し、削除は一覧から取り除きます。登録済みのLINE利用者はどちらの操作でも引き続き利用できます。</div>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>発行日</th><th>登録人数 / 上限</th><th>有効期限</th><th>状態</th><th>操作</th></tr></thead><tbody>{activeInvitations.map((invitation: Row) => <tr key={invitation.id} {...navigableRowProps(() => beginEdit('invitations', invitation), `${date(invitation.created_at)}発行の招待QRを編集`)}>
          <td>{date(invitation.created_at)}</td><td>{invitation.used_count} / {invitation.max_uses ?? '無制限'} 名</td><td>{date(invitation.expires_at)}</td><td><Badge value={invitation.status} /></td>
          <td><div className="admin-inline-actions"><button className="admin-table-detail" onClick={() => beginEdit('invitations', invitation)}>上限・期限変更</button>{invitation.status === 'active' && <button className="admin-text-danger" onClick={() => { setError(''); setConfirm({ type: 'revoke', row: invitation }); }}>無効化</button>}<button className="admin-text-danger" aria-label={`${date(invitation.created_at)}発行の招待QRを削除`} onClick={() => beginDelete('invitations', invitation)}>削除</button></div></td>
        </tr>)}</tbody></table>{!activeInvitations.length && <Empty text="招待QRコードは未発行です" />}</div>
      </section>
      <section className="admin-card">
        <div className="admin-card-head"><h2>登録済みのLINE利用者</h2><span className="admin-muted">{company.line_users?.filter((user: Row) => user.status === 'active').length || 0} 名が利用中</span></div>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>担当者名</th><th>LINE表示名</th><th>登録日時</th><th>状態</th><th>操作</th></tr></thead><tbody>{company.line_users?.map((user: Row) => <tr key={user.id} {...navigableRowProps(() => beginEdit('line-user', user), `${user.staff_name}のLINE登録詳細`)}>
          <td><strong>{user.staff_name}</strong></td><td>{user.line_display_name || '—'}</td><td>{date(user.registered_at, true)}</td><td><Badge value={user.status} /></td><td><div className="admin-inline-actions"><button className="admin-table-detail" onClick={() => beginEdit('line-user', user)}>詳細</button>{user.status === 'active' && <button className="admin-text-danger" onClick={() => { setError(''); setConfirm({ type: 'unlink', row: user }); }}>紐付け解除</button>}</div></td>
        </tr>)}</tbody></table>{!company.line_users?.length && <Empty text="登録済みのLINE利用者はいません" />}</div>
      </section>
    </>}

    {tab === 'prices' && <section className="admin-card">
      <div className="admin-card-head"><div><h2>取引先別の販売単価</h2><span className="admin-muted">すべて税抜。専用単価が空欄の場合は標準卸価格を適用します。行を押すと適用期間も編集できます。</span></div><button className="admin-btn primary" disabled={busy || !changedPrices.length} onClick={() => { setError(''); setConfirm({ type: 'prices' }); }}><Save size={17} />単価設定を保存</button></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>商品名</th><th>容量</th><th className="num">標準卸価格</th><th className="num"><FieldHelp label={`${company.name} 専用単価`} help="空欄かつ取扱可で保存すると標準卸価格に戻ります。0円を設定する場合は0を入力してください。" /></th><th><FieldHelp label="取扱" help="チェックを外すと、この取引先はこの商品を新たに注文できません。業者限定商品には取扱可の専用設定が必要です。" /></th><th>操作</th></tr></thead><tbody>{products.map(product => {
        const draft = priceDraft[product.id];
        const openPrice = () => beginEdit('price', { ...draft, product_id: product.id, valid_from: validFrom, valid_to: '', note: '' });
        return <tr key={product.id} {...navigableRowProps(openPrice, `${product.name} ${product.volume_ml}mlの専用単価を編集`)}>
          <td><strong>{product.name}</strong>{!!product.is_limited && <small className="admin-muted"> 業者限定</small>}</td><td>{product.volume_ml}ml</td><td className="num">{product.standard_price != null ? money(product.standard_price) : '未設定'}</td>
          <td className="num"><div className="admin-price-input"><span>¥</span><input className="admin-input" aria-label={`${product.name} ${product.volume_ml}mlの専用単価`} type="number" min="0" max="10000000" placeholder={product.standard_price == null ? '例：2100' : `標準 ${product.standard_price}円`} value={draft?.unit_price ?? ''} onChange={event => setPriceDraft(current => ({ ...current, [product.id]: { ...current[product.id], unit_price: event.target.value } }))} /></div></td>
          <td><label className="admin-check-label"><input type="checkbox" aria-label={`${product.name} ${product.volume_ml}mlを取扱可にする`} checked={!!draft?.is_available} onChange={event => setPriceDraft(current => ({ ...current, [product.id]: { ...current[product.id], is_available: event.target.checked ? 1 : 0 } }))} />可</label></td>
          <td><button className="admin-table-detail" onClick={openPrice}>編集</button></td>
        </tr>;
      })}</tbody></table>{!products.length && <Empty text="商品が登録されていません" />}</div>
      <div className="admin-price-footer">
        <label className="admin-field"><FieldHelp label="適用開始日" help="上の一覧で変更した商品のみ、この日から適用します。変更していない商品や予約済みの単価は更新しません。" /><input className="admin-input" type="date" required value={validFrom} onChange={event => setValidFrom(event.target.value)} /></label>
        <label className="admin-field"><FieldHelp label="改定の備考" help="今回まとめて変更する商品の単価に記録する備考です。" /><input className="admin-input" value={priceNote} onChange={event => setPriceNote(event.target.value)} placeholder="例：秋季契約単価" /></label>
      </div>
      <details className="admin-price-history"><summary>保存済み・過去の単価設定を見る（{company.prices?.length || 0}件）</summary><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>商品</th><th>単価</th><th>適用期間</th><th>状態</th><th>操作</th></tr></thead><tbody>{company.prices?.map((price: Row) => <tr key={price.id} {...navigableRowProps(() => beginEdit('price-history', price), `${priceName(price)}の保存済み単価を編集`)}>
        <td>{priceName(price)} {price.volume_ml}ml</td><td>{money(price.unit_price)}</td><td>{price.valid_from} 〜 {price.valid_to || '継続'}</td><td>{price.status === 'active' ? price.valid_from > today() ? '適用予定' : price.valid_to && price.valid_to < today() ? '適用終了' : '有効' : '過去の単価'}</td>
        <td><div className="admin-inline-actions"><button className="admin-table-detail" onClick={() => beginEdit('price-history', price)}>編集</button><button className="admin-text-danger" aria-label={`${priceName(price)}の保存済み単価を削除`} onClick={() => beginDelete('price-history', price)}>削除</button></div></td>
      </tr>)}</tbody></table>{!company.prices?.length && <Empty text="専用単価の設定はありません" />}</div></details>
    </section>}

    {tab === 'contracts' && <section className="admin-card">
      <div className="admin-card-head"><h2>契約・請求条件</h2><button className="admin-btn primary" onClick={() => beginEdit('contracts', { status: 'active', closing_day: 31, start_date: today() })}><Plus size={17} />契約を追加</button></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>契約名</th><th>適用期間</th><th>締日</th><th>支払条件</th><th>状態</th><th>操作</th></tr></thead><tbody>{company.contracts?.map((contract: Row) => <tr key={contract.id} {...navigableRowProps(() => beginEdit('contracts', contract), `${contract.contract_name}を編集`)}>
        <td><strong>{contract.contract_name}</strong></td><td>{contract.start_date || '指定なし'} 〜 {contract.end_date || '継続中'}</td><td>{contract.closing_day === 31 ? '月末' : `${contract.closing_day}日`}</td><td>{contract.payment_terms || '—'}</td><td><Badge value={contract.status} /></td><td><div className="admin-inline-actions"><button className="admin-table-detail" onClick={() => beginEdit('contracts', contract)}>編集</button><button className="admin-text-danger" aria-label={`${contract.contract_name}を削除`} onClick={() => beginDelete('contracts', contract)}>削除</button></div></td>
      </tr>)}</tbody></table>{!company.contracts?.length && <Empty text="契約情報が登録されていません" />}</div>
    </section>}

    {tab === 'orders' && <section className="admin-card">
      <div className="admin-card-head"><h2>注文履歴</h2><Link className="admin-text-link" to={`/admin/orders?company_id=${id}`}>注文管理で見る</Link></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>注文番号</th><th>注文日</th><th>到着希望日</th><th className="num">税込合計</th><th>状態</th></tr></thead><tbody>{orders.map(order => <tr key={order.id} {...rowNavigation(`/admin/orders/${order.id}`, `${order.id}の注文詳細`)}><td><Link className="admin-order-id" to={`/admin/orders/${order.id}`}>{order.id}</Link></td><td>{date(order.ordered_at)}</td><td>{date(order.desired_delivery_date)}</td><td className="num">{money(order.total_amount)}</td><td><Badge value={order.status} /></td></tr>)}</tbody></table>{!orders.length && <Empty text="注文履歴はありません" />}</div>
    </section>}

    {editing?.type === 'line-user' && <Modal title="LINE利用者の詳細" onClose={() => setEditing(null)}>
      <div className="admin-modal-body"><div className="admin-detail-grid"><div><label>担当者名</label><strong>{editing.row.staff_name}</strong></div><div><label>LINE表示名</label><strong>{editing.row.line_display_name || '—'}</strong></div><div><label>登録日時</label><span>{date(editing.row.registered_at, true)}</span></div><div><label>状態</label><Badge value={editing.row.status} /></div></div><p className="admin-info-text">招待QRコードを削除・無効化しても、この登録は維持されます。利用を停止する場合は紐付けを解除してください。</p></div>
      <div className="admin-modal-foot"><button className="admin-btn secondary" onClick={() => setEditing(null)}>閉じる</button>{editing.row.status === 'active' && <button className="admin-btn secondary" onClick={() => { setConfirm({ type: 'unlink', row: editing.row }); setEditing(null); }}><Users size={16} />紐付け解除</button>}</div>
    </Modal>}
    {editing && editing.type !== 'line-user' && <EntityForm
      title={editing.type === 'company' ? '取引先情報を編集' : editing.type === 'addresses' ? '配送先を登録・編集' : editing.type === 'contracts' ? '契約を登録・編集' : editing.type === 'price' || editing.type === 'price-history' ? `${priceName(editing.row)}の専用単価を編集` : editing.row.id ? '招待QRの上限・期限を変更' : 'LINE招待QRコードを発行'}
      fields={editing.type === 'company' ? companyFields : editing.type === 'addresses' ? addressFields.map(field => field.key === 'shipping_rule_id' ? { ...field, options: [['', '自動判定'], ...rules.map(rule => [rule.id, rule.name] as [string, string])] as [string, string][] } : field) : editing.type === 'contracts' ? contractFields : editing.type === 'price-history' ? savedPriceFields : editing.type === 'price' ? priceFields : invitationFields}
      initial={editing.row}
      extra={editing.type === 'price' || editing.type === 'price-history' ? { product_id: editing.row.product_id } : undefined}
      path={editing.type === 'company' ? `/api/admin/companies/${id}` : editing.type === 'price' ? `/api/admin/companies/${id}/prices` : editing.type === 'price-history' ? `/api/admin/companies/${id}/prices/${editing.row.id}` : `/api/admin/companies/${id}/${editing.type}${editing.row.id ? `/${editing.row.id}` : ''}`}
      method={editing.type === 'price' ? 'POST' : editing.row.id ? 'PUT' : 'POST'}
      onClose={() => setEditing(null)}
      onDelete={editing.row.id ? () => beginDelete(editing.type, editing.row) : undefined}
      onSaved={async result => {
        if (editing.type === 'invitations' && !editing.row.id) {
          const token = result.token || result.invitation_token;
          const url = result.url || result.invitation_url || (token ? `${window.location.origin}/invite?t=${encodeURIComponent(token)}` : null);
          if (url) setQr({ ...result, url });
        }
        setEditing(null); await load(); setSuccess('保存しました。');
      }}
    />}

    <ConfirmDialog open={!!confirm} title={confirm?.type === 'prices' ? '販売単価を保存しますか？' : confirm?.type === 'revoke' ? '招待QRコードを無効にしますか？' : confirm?.type === 'unlink' ? 'LINE利用者の紐付けを解除しますか？' : confirm?.entity === 'invitations' ? '招待QRコードを削除しますか？' : `${deleteName(confirm) || 'この情報'}を削除しますか？`} onClose={() => { if (!busy) setConfirm(null); }} busy={busy} onConfirm={() => void run()}>
      <ErrorBox error={error} />
      <p>{confirm?.type === 'prices' ? `変更した${changedPrices.length}商品の設定を${date(validFrom)}から適用します。すでに受け付けた注文の単価は変わりません。` : confirm?.type === 'revoke' ? 'このQRコードからの新しい登録を停止します。登録済みの担当者は引き続き利用できます。' : confirm?.type === 'unlink' ? `${confirm.row?.staff_name || 'この担当者'}さんは、この取引先の注文を利用できなくなります。` : confirm?.entity === 'invitations' ? 'この招待QRコードを一覧から削除し、新しい登録を停止します。登録済みのLINE利用者と注文履歴は保持され、引き続き利用できます。招待URLは再表示できません。' : confirm?.entity === 'price-history' ? 'この専用単価の設定を削除します。新しい注文では、残っている有効な専用単価があればその単価、それ以外は標準卸価格を適用します。業者限定商品は取扱条件をご確認ください。過去の注文の単価は変わりません。' : confirm?.entity === 'company' ? '取引先一覧から削除し、新しい注文・登録を停止します。過去の注文・請求・LINE登録の記録は保持します。' : '一覧から削除します。過去の注文・請求で使用した情報は履歴として保持します。'}</p>
    </ConfirmDialog>

    {qr && <Modal title="招待QRコードを発行しました" onClose={() => setQr(null)} wide>
      <div className="admin-modal-body"><div className="admin-alert info">このURLは後から再表示できません。案内状を印刷またはPDF保存してください。</div><ErrorBox error={error} /><div className="admin-qr-letter" id="admin-qr-letter"><span className="admin-eyebrow">小島醸造 受注サービス</span><h2>LINE注文サービスのご案内</h2><h3>{company.name} 御中</h3><p>いつもお引き立ていただき、ありがとうございます。<br />LINEからかんたんに、ご注文いただけます。</p>{qrImage && <img src={qrImage} width="240" height="240" alt="LINE注文サービス登録用QRコード" />}<ol><li>普段使うスマートフォンでQRコードを読み取り、LINEアプリで開く</li><li>ご担当者さまのお名前を入力して「登録する」を押す</li><li>メニューの「注文」からお買い物を始める</li></ol><p>有効期限：{date(qr.expires_at)} ／ 登録上限：{qr.max_uses ?? '無制限'}名</p><small style={{ overflowWrap: 'anywhere' }}>{qr.url}</small></div></div>
      <div className="admin-modal-foot"><button className="admin-btn secondary" onClick={async () => { try { await navigator.clipboard.writeText(qr.url); setSuccess('招待URLをコピーしました。'); } catch { setError('URLをコピーできませんでした。表示されたURLを選択してコピーしてください。'); } }}><Copy size={17} />URLをコピー</button><Link className="admin-btn primary" to="/admin/reports/invitation" state={{ invitation: { ...qr, company_name: company.name } }}><Printer size={17} />案内状プレビュー・PDF保存</Link></div>
    </Modal>}
  </>;
}

function EntityForm({ title, fields, initial, path, method, extra, onClose, onSaved, onDelete }: {
  title: string;
  fields: Field[];
  initial: Row;
  path: string;
  method?: string;
  extra?: Row;
  onClose: () => void;
  onSaved: (data: any) => void | Promise<void>;
  onDelete?: () => void;
}) {
  const [form, setForm] = useState<Row>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const update = (key: string, value: any) => { setForm(current => ({ ...current, [key]: value })); setConfirming(false); setError(''); };

  async function save() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body: Row = { ...extra };
      for (const field of fields) {
        let value = form[field.key] ?? '';
        if (field.type === 'number') value = value === '' ? null : Number(value);
        if (field.type === 'checkbox') value = value ? 1 : 0;
        if (['shipping_rule_id', 'end_date', 'start_date', 'valid_to'].includes(field.key) && !value) value = null;
        if (field.key === 'expires_at' && value) value = new Date(`${String(value).slice(0, 10)}T23:59:59+09:00`).toISOString();
        body[field.key] = value;
      }
      if (body.start_date && body.end_date && body.end_date < body.start_date) throw new Error('終了日は開始日以降を指定してください。');
      if (body.valid_from && body.valid_to && body.valid_to < body.valid_from) throw new Error('適用終了日は適用開始日以降を指定してください。');
      const result = await api(path, { method: method || (initial.id ? 'PUT' : 'POST'), body: JSON.stringify(body) });
      await onSaved(result);
    } catch (err) { setError((err as Error).message); setConfirming(false); }
    finally { setBusy(false); }
  }

  return <Modal title={title} onClose={() => { if (!busy) onClose(); }} wide>
    <form onSubmit={event => { event.preventDefault(); setConfirming(true); }}>
      <div className="admin-modal-body"><ErrorBox error={error} /><div className="admin-form-grid" style={{ minWidth: 0, maxWidth: '100%' }}>
        {fields.map(field => <label key={field.key} className={`admin-field ${field.wide ? 'span-2' : ''}`} style={{ minWidth: 0, maxWidth: '100%' }}>
          {field.type === 'checkbox' ? <><span className="admin-check-label"><input type="checkbox" checked={!!form[field.key]} onChange={event => update(field.key, event.target.checked ? 1 : 0)} />{field.label}<FieldHelp label={field.label} help={field.help} hideLabel /></span></> : <>
            <span><FieldHelp label={field.label} help={field.help} />{field.required && <span className="admin-required">必須</span>}</span>
            {field.type === 'textarea' ? <textarea className="admin-input" rows={3} value={form[field.key] || ''} onChange={event => update(field.key, event.target.value)} placeholder={field.placeholder} required={field.required} style={{ minWidth: 0, maxWidth: '100%', width: '100%' }} /> : field.type === 'select' ? <select className="admin-select" value={form[field.key] || ''} onChange={event => update(field.key, event.target.value)} required={field.required} style={{ minWidth: 0, maxWidth: '100%', width: '100%' }}>{field.options?.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select> : <input className="admin-input" type={field.type || 'text'} value={field.type === 'date' ? dateFieldValue(form[field.key]) : form[field.key] ?? ''} onChange={event => update(field.key, event.target.value)} required={field.required} min={field.min} max={field.max} step={field.type === 'number' ? 1 : undefined} placeholder={field.placeholder} style={{ minWidth: 0, maxWidth: '100%', width: '100%' }} />}
          </>}
        </label>)}
      </div>{confirming && <div className="admin-alert info">入力内容を確認しました。下の「確認して保存」を押すと反映されます。</div>}</div>
      <div className="admin-modal-foot">
        {onDelete && <button type="button" className="admin-btn secondary" onClick={onDelete} disabled={busy}><Trash2 size={16} />削除</button>}
        <button type="button" className="admin-btn secondary" onClick={onClose} disabled={busy}>戻る</button>
        {confirming ? <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '確認して保存'}</button> : <button className="admin-btn primary" type="submit"><Save size={17} />入力内容を確認</button>}
      </div>
    </form>
  </Modal>;
}
