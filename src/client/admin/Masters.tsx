import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Wine, Boxes, CalendarDays, Check, ChevronLeft, ChevronRight, CircleAlert, FileText, Landmark, Loader2, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Truck, X } from 'lucide-react';
import { api } from './api';
import RichMenu from './RichMenu';
import './masters.css';

type Row = Record<string, any>;
type Field = { key: string; label: string; type?: string; required?: boolean; options?: [string, string][]; hint?: string; min?: number; step?: string; wide?: boolean; pattern?: string };
type ResourceConfig = { path: string; title: string; singular: string; description: string; key?: string; fields: Field[]; defaults: Row; columns: { key: string; label: string; render?: (row: Row) => ReactNode }[] };
const yen = (value: unknown) => value === null || value === undefined || value === '' ? '未設定' : `¥${Number(value).toLocaleString('ja-JP')}`;
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const nowDate = () => dateKey(new Date());
const activeOptions: [string, string][] = [['active', '有効'], ['inactive', '無効']];
const productStatus: Record<string, string> = { on_sale: '販売中', suspended: '販売停止', unavailable: '注文不可' };
const errorText = (e: unknown) => e instanceof Error ? e.message : '処理に失敗しました。もう一度お試しください。';
const list = (data: any): Row[] => Array.isArray(data) ? data : data?.items || [];
const readable = (value: unknown) => typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—');

function useModalFocus(open: boolean, onClose: () => void, busy = false) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const page = dialog.closest('.master-page');
    const oldOverflow = document.body.style.overflow;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length > 0);
    const focusFirst = () => (dialog.querySelector<HTMLElement>('input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)') || focusable()[0] || dialog).focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    function onFocusIn(event: FocusEvent) {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
    }
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    focusFirst();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = oldOverflow;
      if (previous?.isConnected) previous.focus();
      else if (page?.isConnected) page.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    };
  }, [open]);
  return dialogRef;
}

function Badge({ value }: { value: string }) {
  const label = productStatus[value] || ({ active: '有効', inactive: '無効', admin: '管理者', customer: 'お客様', system: 'システム' } as Record<string, string>)[value] || value;
  return <span className={`admin-badge master-badge ${['active', 'on_sale'].includes(value) ? 'master-badge-good' : value === 'suspended' ? 'master-badge-warn' : ''}`}>{label}</span>;
}

function Notice({ error, success }: { error?: string; success?: string }) {
  if (error) return <div className="admin-alert master-notice master-notice-error" role="alert"><CircleAlert size={18} />{error}</div>;
  if (success) return <div className="admin-alert master-notice master-notice-success" role="status"><Check size={18} />{success}</div>;
  return null;
}

function Fields({ fields, value, setValue, lockedKey }: { fields: Field[]; value: Row; setValue: (v: Row) => void; lockedKey?: string }) {
  return <div className="admin-form-grid">{fields.map(field => {
    const id = `master-${field.key}`;
    const common = { id, name: field.key, required: field.required, disabled: lockedKey === field.key, className: field.options ? 'admin-select' : 'admin-input' };
    const val = value[field.key] ?? '';
    let displayed = val;
    if (field.type === 'volumes') {
      try { const volumes = typeof val === 'string' ? JSON.parse(val) : val; if (Array.isArray(volumes)) displayed = volumes.join(', '); } catch { /* Keep the user's in-progress entry. */ }
    }
    if (field.type === 'cities') {
      try { const condition = typeof val === 'string' ? JSON.parse(val) : val; if (typeof condition === 'object' && condition !== null) displayed = Array.isArray(condition.cities) ? condition.cities.join(', ') : ''; } catch { /* Keep the user's in-progress entry. */ }
    }
    if (field.type === 'periods') {
      try { const periods = typeof val === 'string' ? JSON.parse(val) : val; if (Array.isArray(periods)) displayed = periods.map(p => `${p.start_day}-${p.end_day}`).join(', '); } catch { /* Keep the user's in-progress entry. */ }
    }
    return <div className={`admin-field ${field.wide || field.type === 'textarea' || field.type === 'json' ? 'master-field-wide' : ''}`} key={field.key}>
      {field.type === 'checkbox' ? <label className="master-checkbox"><input id={id} type="checkbox" checked={val === true || val === 1 || val === 'true'} onChange={e => setValue({ ...value, [field.key]: e.target.checked ? 1 : 0 })} />{field.label}</label> : <><label htmlFor={id}>{field.label}{field.required && <span className="master-required">必須</span>}</label>
        {field.options ? <select {...common} value={String(val)} onChange={e => setValue({ ...value, [field.key]: e.target.value })}>{!field.required && <option value="">選択してください</option>}{field.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
          : field.type === 'textarea' || field.type === 'json' ? <textarea {...common} rows={field.type === 'json' ? 3 : 4} value={typeof val === 'object' ? JSON.stringify(val, null, 2) : val} onChange={e => setValue({ ...value, [field.key]: e.target.value })} />
            : <input {...common} type={['volumes', 'cities', 'periods'].includes(field.type || '') ? 'text' : field.type || 'text'} min={field.min} step={field.step || (field.type === 'number' ? '1' : undefined)} pattern={field.pattern} value={displayed} onChange={e => setValue({ ...value, [field.key]: field.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} />}</>}
      {field.hint && <small className="admin-muted">{field.hint}</small>}
    </div>;
  })}</div>;
}

function normalizeFields(value: Row, fields: Field[]): Row {
  const result = { ...value };
  for (const field of fields) {
    if (field.type === 'volumes') {
      const raw = result[field.key];
      let volumes: unknown;
      try { volumes = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* Parse the plain list below. */ }
      if (!Array.isArray(volumes)) volumes = String(raw || '').split(/[,、\s]+/).filter(Boolean).map(Number);
      if (!Array.isArray(volumes) || !volumes.length || volumes.some(v => !Number.isInteger(v) || Number(v) <= 0)) throw new Error('対応容量には、300, 500, 700 のように正の整数を入力してください。');
      result[field.key] = JSON.stringify([...new Set(volumes)]);
    }
    if (field.type === 'cities') {
      const raw = result[field.key];
      let condition: any;
      try { condition = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* Parse the plain list below. */ }
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) condition = { cities: String(raw || '').split(/[,、\n]+/).map(s => s.trim()).filter(Boolean) };
      result[field.key] = JSON.stringify(condition);
    }
    if (field.type === 'periods') {
      const raw = result[field.key];
      let periods: any;
      try { periods = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* Parse the plain list below. */ }
      if (!Array.isArray(periods)) {
        periods = String(raw || '').split(/[,、]+/).map(s => s.trim()).filter(Boolean).map(part => {
          const match = part.match(/^(\d{1,2})\s*[-〜～ー]\s*(\d{1,2})$/);
          if (!match) throw new Error('配送可能期間は 1-7, 15-22 のように入力してください。');
          return { start_day: Number(match[1]), end_day: Number(match[2]) };
        });
      }
      if (periods.some((p: any) => !Number.isInteger(p.start_day) || !Number.isInteger(p.end_day) || p.start_day < 1 || p.end_day > 31 || p.start_day > p.end_day)) throw new Error('配送可能期間は1〜31日で、開始日から終了日の順に入力してください。');
      result[field.key] = JSON.stringify(periods);
    }
    if (field.type === 'json') {
      if (result[field.key] === '') result[field.key] = null;
      else if (typeof result[field.key] === 'string') {
        try { JSON.parse(result[field.key]); } catch { throw new Error(`${field.label}を正しいJSON形式で入力してください。`); }
      }
    }
    if ((field.type === 'number' || field.type === 'date') && result[field.key] === '') result[field.key] = null;
  }
  return result;
}

const productFields: Field[] = [
  { key: 'name', label: '商品名', required: true }, { key: 'category', label: '商品区分', hint: '例：新酒・ガラス瓶' },
  { key: 'volume_ml', label: '容量（ml）', type: 'number', required: true, min: 1 }, { key: 'unit', label: '販売単位', required: true },
  { key: 'standard_price', label: '標準卸価格（税抜・円）', type: 'number', min: 0, hint: '未入力の場合は価格未設定となり、注文できません。' }, { key: 'weight_kg', label: '1本重量（kg）', type: 'number', step: '0.001', min: 0.001, required: true, hint: '内容物と容器を含む重量。送料計算に使用します。' },
  { key: 'sales_status', label: '販売状態', required: true, options: Object.entries(productStatus) }, { key: 'sort_order', label: '表示順', type: 'number', min: 0 },
  { key: 'image_url', label: '商品画像URL / アセットパス', wide: true }, { key: 'short_description', label: '短い商品説明', wide: true, hint: '注文画面の商品カードに表示されます。' },
  { key: 'description', label: '商品紹介 ① 商品説明', type: 'textarea' }, { key: 'commitment', label: '商品紹介 ② こだわり', type: 'textarea' },
  { key: 'taste', label: '商品紹介 ③ 味わい', type: 'textarea' }, { key: 'recommended_way', label: '商品紹介 ④ おすすめの飲み方', type: 'textarea' },
  { key: 'is_limited', label: '業者限定商品として表示する', type: 'checkbox' }, { key: 'note', label: '管理用メモ', type: 'textarea' },
];
const productConfig: ResourceConfig = {
  path: 'products', title: '商品一覧', singular: '商品', description: '標準卸価格や販売状態、LINEに表示する商品紹介を管理します。',
  fields: productFields, defaults: { name: '', category: '', volume_ml: 700, unit: '本', standard_price: '', weight_kg: '', tax_type: 'excl', sales_status: 'unavailable', is_limited: 0, sort_order: 0 },
  columns: [
    { key: 'name', label: '商品名', render: r => <div className="master-product-cell"><span className="master-product-icon"><Wine size={23} /></span><span><strong>{r.name}</strong><small className="admin-muted">{r.category || '区分未設定'}{r.is_limited ? ' ・ 業者限定' : ''}</small></span></div> },
    { key: 'volume_ml', label: '容量', render: r => `${Number(r.volume_ml).toLocaleString()} ml` }, { key: 'standard_price', label: '標準卸価格（税抜）', render: r => <strong>{yen(r.standard_price)}</strong> },
    { key: 'weight_kg', label: '重量', render: r => `${r.weight_kg} kg` }, { key: 'sales_status', label: '販売状態', render: r => <Badge value={r.sales_status} /> },
  ],
};

const shippingConfigs: Record<string, ResourceConfig> = {
  boxes: {
    path: 'boxes', title: '梱包箱', singular: '梱包箱', description: '商品容量・本数・重量から、適切な梱包箱を自動選定します。', defaults: { supported_volumes_json: '[300,500,700]', max_bottles: 6, box_weight_kg: 0.3, allow_mixed: 1, priority: 10, status: 'active', valid_from: nowDate() },
    fields: [
      { key: 'name', label: '箱名', required: true }, { key: 'supported_volumes_json', label: '対応容量（ml）', type: 'volumes', required: true, hint: '複数ある場合はカンマで区切ります。例：300, 500, 700' },
      { key: 'max_bottles', label: '最大本数', type: 'number', min: 1, required: true }, { key: 'length_cm', label: '縦（cm）', type: 'number', min: 0.1, step: '0.1', required: true },
      { key: 'width_cm', label: '横（cm）', type: 'number', min: 0.1, step: '0.1', required: true }, { key: 'height_cm', label: '高さ（cm）', type: 'number', min: 0.1, step: '0.1', required: true },
      { key: 'box_weight_kg', label: '箱重量（kg）', type: 'number', min: 0, step: '0.001', required: true }, { key: 'target_condition', label: '対応商品条件' }, { key: 'allow_mixed', label: '異なる容量の混載を許可する', type: 'checkbox' },
      { key: 'priority', label: '優先順位', type: 'number', min: 0, hint: '小さい数字から優先して使用します。' }, { key: 'valid_from', label: '適用開始日', type: 'date' }, { key: 'valid_to', label: '適用終了日', type: 'date' },
      { key: 'status', label: '状態', required: true, options: activeOptions }, { key: 'note', label: '管理用メモ', type: 'textarea' },
    ],
    columns: [{ key: 'name', label: '箱名' }, { key: 'supported_volumes_json', label: '対応容量', render: r => { try { return `${JSON.parse(r.supported_volumes_json).join(' / ')} ml`; } catch { return r.supported_volumes_json; } } }, { key: 'max_bottles', label: '最大本数', render: r => `${r.max_bottles}本` }, { key: 'dimensions', label: 'サイズ / 箱重量', render: r => `${r.length_cm} × ${r.width_cm} × ${r.height_cm} cm / ${r.box_weight_kg} kg` }, { key: 'status', label: '状態', render: r => <Badge value={r.status} /> }],
  },
  sizes: {
    path: 'sizes', title: 'ヤマトサイズ', singular: 'サイズ', key: 'size_code', description: '三辺合計と総重量の両方を満たす最小サイズを使用します。', defaults: { status: 'active', valid_from: nowDate() },
    fields: [{ key: 'size_code', label: 'サイズコード', required: true, options: ['60', '80', '100', '120', '140', '160', '180', '200'].map(x => [x, `${x}サイズ`]) }, { key: 'max_three_sides_cm', label: '三辺合計上限（cm）', type: 'number', min: 1, step: '0.1', required: true }, { key: 'max_weight_kg', label: '重量上限（kg）', type: 'number', min: 0.1, step: '0.1', required: true }, { key: 'valid_from', label: '適用開始日', type: 'date' }, { key: 'valid_to', label: '適用終了日', type: 'date' }, { key: 'status', label: '状態', required: true, options: activeOptions }],
    columns: [{ key: 'size_code', label: 'サイズ', render: r => <strong>{r.size_code}サイズ</strong> }, { key: 'max_three_sides_cm', label: '三辺合計上限', render: r => `${r.max_three_sides_cm} cm` }, { key: 'max_weight_kg', label: '重量上限', render: r => `${r.max_weight_kg} kg` }, { key: 'valid_from', label: '適用開始日' }, { key: 'status', label: '状態', render: r => <Badge value={r.status} /> }],
  },
  rates: {
    path: 'rates', title: 'ヤマト運賃', singular: '運賃', description: '地域・サイズごとの送料を税抜で設定します。契約運賃を優先します。', defaults: { origin_region: '中部', rate_type: 'contract', status: 'active', valid_from: nowDate() },
    fields: [{ key: 'origin_region', label: '発送地域', required: true }, { key: 'dest_region', label: '到着地域（都道府県）', required: true }, { key: 'size_code', label: 'サイズコード', required: true, options: ['60', '80', '100', '120', '140', '160', '180', '200'].map(x => [x, `${x}サイズ`]) }, { key: 'shipping_fee', label: '送料（税抜・円）', type: 'number', min: 0, required: true }, { key: 'rate_type', label: '料金種別', required: true, options: [['contract', '契約運賃'], ['standard', '一般運賃']] }, { key: 'valid_from', label: '適用開始日', type: 'date' }, { key: 'valid_to', label: '適用終了日', type: 'date' }, { key: 'status', label: '状態', required: true, options: activeOptions }, { key: 'note', label: '管理用メモ', type: 'textarea' }],
    columns: [{ key: 'dest_region', label: '到着地域', render: r => <strong>{r.dest_region}</strong> }, { key: 'origin_region', label: '発送地域' }, { key: 'size_code', label: 'サイズ', render: r => `${r.size_code}サイズ` }, { key: 'shipping_fee', label: '送料（税抜）', render: r => yen(r.shipping_fee) }, { key: 'rate_type', label: '料金種別', render: r => r.rate_type === 'contract' ? '契約運賃' : '一般運賃' }, { key: 'status', label: '状態', render: r => <Badge value={r.status} /> }],
  },
  'shipping-rules': {
    path: 'shipping-rules', title: '配送ルール', singular: '配送ルール', description: '対象地域、自社配達・ヤマト宅急便、配送可能期間を管理します。', defaults: { delivery_method: 'yamato', is_free_shipping: 0, status: 'active', target_condition_json: '{}', allowed_periods_json: '[]' },
    fields: [{ key: 'name', label: 'ルール名', required: true }, { key: 'delivery_method', label: '配送方法', required: true, options: [['own_delivery', '自社配達'], ['yamato', 'ヤマト宅急便']] }, { key: 'target_condition_json', label: '対象の市区町村', type: 'cities', hint: '例：犬山市, 江南市。空欄の場合はすべての地域が対象です。' }, { key: 'allowed_periods_json', label: '毎月の配送可能期間', type: 'periods', hint: '例：1-7, 15-22（毎月1〜7日と15〜22日）。空欄の場合は日付を制限しません。' }, { key: 'is_free_shipping', label: '送料無料とする', type: 'checkbox' }, { key: 'status', label: '状態', required: true, options: activeOptions }, { key: 'note', label: '管理用メモ', type: 'textarea' }],
    columns: [{ key: 'name', label: 'ルール名', render: r => <strong>{r.name}</strong> }, { key: 'delivery_method', label: '配送方法', render: r => r.delivery_method === 'own_delivery' ? '自社配達' : 'ヤマト宅急便' }, { key: 'is_free_shipping', label: '送料', render: r => r.is_free_shipping ? '無料' : '運賃マスターに従う' }, { key: 'status', label: '状態', render: r => <Badge value={r.status} /> }],
  },
};

function Resource({ config }: { config: ResourceConfig }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [editor, setEditor] = useState<Row | null>(null);
  const [original, setOriginal] = useState<Row | null>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useModalFocus(editor !== null, () => setEditor(null), busy);
  const idKey = config.key || 'id';
  async function refresh() {
    setLoading(true); setError('');
    try { setRows(list(await api(`/api/admin/${config.path}`))); } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [config.path]);
  const filtered = useMemo(() => rows.filter(r => (!query || `${r.name || ''} ${r.category || ''} ${r.dest_region || ''} ${r.size_code || ''}`.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || (r.sales_status || r.status) === filter)), [rows, query, filter]);
  function edit(row?: Row) { setOriginal(row || null); setEditor(row ? { ...row } : { ...config.defaults }); setFormError(''); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editor || busy) return;
    setFormError('');
    let payload: Row;
    try { payload = normalizeFields(editor, config.fields); } catch (e) { setFormError(errorText(e)); return; }
    if (payload.valid_from && payload.valid_to && payload.valid_from > payload.valid_to) { setFormError('適用終了日は開始日以降にしてください。'); return; }
    const priceChanged = original && config.path === 'products' && original.standard_price !== payload.standard_price;
    if (!window.confirm(priceChanged ? `標準卸価格を ${yen(original.standard_price)} から ${yen(payload.standard_price)} に変更します。登録済み注文の単価は維持されます。保存しますか？` : `${config.singular}の内容を保存しますか？`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/${config.path}${original ? `/${encodeURIComponent(String(original[idKey]))}` : ''}`, { method: original ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setEditor(null); setSuccess(`${config.singular}を保存しました。`); await refresh();
    } catch (e) { setFormError(errorText(e)); } finally { setBusy(false); }
  }
  return <>
    <Notice error={error} success={success} />
    <section className="admin-card">
      <div className="admin-card-head"><div><h2>{config.title}</h2><p className="admin-muted">{config.description}</p></div><button className="admin-btn primary" onClick={() => edit()}><Plus size={17} />{config.singular}を追加</button></div>
      <div className="master-toolbar"><label className="master-search"><Search size={18} /><input aria-label={`${config.singular}を検索`} placeholder={`${config.singular}を検索…`} value={query} onChange={e => setQuery(e.target.value)} /></label><select className="admin-select" value={filter} onChange={e => setFilter(e.target.value)} aria-label="状態で絞り込む"><option value="all">すべての状態</option>{(config.path === 'products' ? Object.entries(productStatus) : activeOptions).map(([v, label]) => <option value={v} key={v}>{label}</option>)}</select><button className="admin-btn secondary master-icon-button" onClick={() => void refresh()} disabled={loading} aria-label="一覧を再読み込み"><RefreshCw size={17} className={loading ? 'master-spin' : ''} /></button><span className="admin-muted master-count">{filtered.length} 件</span></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{config.columns.map(c => <th key={c.key}>{c.label}</th>)}<th>操作</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={config.columns.length + 1}><div className="master-empty"><Loader2 className="master-spin" size={22} />読み込み中…</div></td></tr> : filtered.length ? filtered.map(r => <tr key={r[idKey]}>{config.columns.map(c => <td key={c.key}>{c.render ? c.render(r) : r[c.key] || '—'}</td>)}<td><button className="admin-btn secondary" onClick={() => edit(r)}><Pencil size={14} />編集</button></td></tr>) : <tr><td colSpan={config.columns.length + 1}><div className="master-empty"><Boxes size={30} /><strong>{query || filter !== 'all' ? '条件に合うデータがありません' : `${config.singular}がまだ登録されていません`}</strong><span className="admin-muted">{query || filter !== 'all' ? '検索条件を変更してください。' : `「${config.singular}を追加」から登録してください。`}</span></div></td></tr>}
      </tbody></table></div>
    </section>
    {editor && <div className="master-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setEditor(null); }}><section ref={dialogRef} tabIndex={-1} className="master-modal" role="dialog" aria-modal="true" aria-labelledby="master-editor-title"><header><div><span className="master-eyebrow">MASTER DATA</span><h2 id="master-editor-title">{config.singular}を{original ? '編集' : '追加'}</h2></div><button className="admin-btn secondary master-icon-button" aria-label="閉じる" onClick={() => setEditor(null)} disabled={busy}><X size={20} /></button></header><form onSubmit={save}><div className="master-modal-body"><Notice error={formError} /><Fields fields={config.fields} value={editor} setValue={setEditor} lockedKey={original ? config.key : undefined} /></div><footer><span className="admin-muted">変更内容は監査ログに記録されます。</span><button className="admin-btn secondary" type="button" disabled={busy} onClick={() => setEditor(null)}>キャンセル</button><button className="admin-btn primary" disabled={busy} type="submit">{busy ? <Loader2 className="master-spin" size={17} /> : <Check size={17} />}{busy ? '保存中…' : '保存する'}</button></footer></form></section></div>}
  </>;
}

function DeliveryCalendar() {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selected, setSelected] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const start = dateKey(month), end = dateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  const indexed = useMemo(() => new Map(rows.map(row => [row.date, row])), [rows]);
  async function refresh() { setLoading(true); setError(''); try { setRows(list(await api(`/api/admin/calendar?from=${start}&to=${end}`))); } catch (e) { setError(errorText(e)); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); setSelected(null); }, [start]);
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const slots = Math.ceil((month.getDay() + count) / 7) * 7;
  function move(delta: number) { setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1)); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!selected) return;
    setBusy(true); setError('');
    try { await api(`/api/admin/calendar/${selected.date}`, { method: 'PUT', body: JSON.stringify(selected) }); setSuccess(`${selected.date} の配送設定を保存しました。`); setSelected(null); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <><Notice error={error} success={success} /><section className="admin-card"><div className="admin-card-head"><div><h2>配送カレンダー</h2><p className="admin-muted">日付を選択して配送可否や休業理由を設定します。</p></div><div className="master-month-nav"><button className="admin-btn secondary master-icon-button" onClick={() => move(-1)} aria-label="前月"><ChevronLeft size={18} /></button><strong>{month.getFullYear()}年 {month.getMonth() + 1}月</strong><button className="admin-btn secondary master-icon-button" onClick={() => move(1)} aria-label="翌月"><ChevronRight size={18} /></button><button className="admin-btn secondary" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>今月</button></div></div><div className="master-calendar-legend"><span><i className="master-dot good" />配送可能</span><span><i className="master-dot closed" />配送不可</span><span><i className="master-dot" />通常の配送ルール</span></div>
      {loading ? <div className="master-empty"><Loader2 className="master-spin" />カレンダーを読み込み中…</div> : <div className="master-calendar"><div className="master-calendar-week">{['日', '月', '火', '水', '木', '金', '土'].map((d, i) => <span className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''} key={d}>{d}</span>)}</div><div className="master-calendar-grid">{Array.from({ length: slots }, (_, index) => { const day = index - month.getDay() + 1; if (day < 1 || day > count) return <div className="master-calendar-blank" key={index} />; const date = dateKey(new Date(month.getFullYear(), month.getMonth(), day)); const entry = indexed.get(date); return <button key={date} className={`master-calendar-day ${entry ? entry.is_deliverable ? 'deliverable' : 'closed' : ''} ${selected?.date === date ? 'selected' : ''} ${date === nowDate() ? 'today' : ''}`} onClick={() => setSelected(entry ? { ...entry } : { date, is_deliverable: 1, reason: '', note: '' })} aria-label={`${date} ${entry ? entry.is_deliverable ? '配送可能' : `配送不可 ${entry.reason || ''}` : '通常ルール'}`}><span className={index % 7 === 0 ? 'sun' : index % 7 === 6 ? 'sat' : ''}>{day}</span><small>{entry ? entry.is_deliverable ? '配送可能' : entry.reason || '配送不可' : '通常ルール'}</small></button>; })}</div></div>}
      <p className="admin-muted master-calendar-footnote">「通常ルール」の日は、配送ルール・営業日・リードタイムに基づいて注文可否を判定します。</p>
    </section>
    {selected && <section className="admin-card master-day-editor"><div className="admin-card-head"><div><h2>{selected.date} の配送設定</h2><p className="admin-muted">この日の設定は通常の配送カレンダーより優先されます。</p></div><button className="admin-btn secondary master-icon-button" onClick={() => setSelected(null)} disabled={busy} aria-label="日付の編集を閉じる"><X size={18} /></button></div><form onSubmit={save}><Fields value={selected} setValue={setSelected} fields={[{ key: 'is_deliverable', label: 'この日は配送可能', type: 'checkbox' }, { key: 'reason', label: '配送不可理由', options: [['定休日', '定休日'], ['イベント出店', 'イベント出店'], ['休業日', '休業日'], ['その他', 'その他']] }, { key: 'note', label: '管理用メモ', type: 'textarea' }]} /><div className="master-form-actions"><button className="admin-btn primary" disabled={busy}>{busy ? <Loader2 size={17} className="master-spin" /> : <Check size={17} />}この日の設定を保存</button></div></form></section>}
  </>;
}

const companyFields: Field[] = [
  { key: 'company_name', label: '会社名', required: true }, { key: 'display_name', label: '帳票表示名', required: true }, { key: 'postal_code', label: '郵便番号' }, { key: 'address', label: '住所' },
  { key: 'tel', label: '電話番号', type: 'tel' }, { key: 'fax', label: 'FAX' }, { key: 'email', label: 'メールアドレス', type: 'email' }, { key: 'contact_person', label: '担当者名' },
  { key: 'invoice_reg_no', label: '適格請求書発行事業者登録番号', pattern: 'T[0-9]{13}', hint: 'T＋13桁の数字' }, { key: 'bank_name', label: '銀行名' }, { key: 'bank_branch_name', label: '支店名' }, { key: 'bank_account_type', label: '預金種別', options: [['普通', '普通'], ['当座', '当座']] },
  { key: 'bank_account_number', label: '口座番号', pattern: '[0-9]{6,7}', hint: '6〜7桁の数字。6桁は先頭に0を補完します。' }, { key: 'bank_account_holder', label: '口座名義（カナ）' }, { key: 'note', label: '管理用メモ', type: 'textarea' },
];
const reportFields: Field[] = [
  { key: 'delivery_note_title', label: '納品書タイトル', required: true }, { key: 'invoice_title', label: '請求書タイトル', required: true }, { key: 'numbering_rule', label: '採番ルール', hint: '例：OYYYYMMDDNNNN / INVYYYYMMNNN', wide: true },
  { key: 'show_issuer_info', label: '発行元情報を表示', type: 'checkbox' }, { key: 'show_invoice_reg_no', label: '適格請求書登録番号を表示', type: 'checkbox' }, { key: 'show_contact_person', label: '担当者名を表示', type: 'checkbox' }, { key: 'show_fax', label: 'FAXを表示', type: 'checkbox' }, { key: 'show_email', label: 'メールアドレスを表示', type: 'checkbox' },
  { key: 'delivery_note_template', label: '納品書の備考テンプレート', type: 'textarea' }, { key: 'invoice_note_template', label: '請求書の備考テンプレート', type: 'textarea' },
];
const systemFields: Field[] = [
  { key: 'tax_rate', label: '消費税率（%）', type: 'number', min: 0, step: '0.1', required: true }, { key: 'tax_calc_unit', label: '税計算単位', required: true, options: [['invoice', '請求単位'], ['order', '注文単位'], ['item', '明細単位']] },
  { key: 'tax_rounding', label: '消費税の端数処理', required: true, options: [['floor', '切り捨て'], ['ceil', '切り上げ'], ['round', '四捨五入']] }, { key: 'shipping_taxable', label: '配送料を課税対象にする', type: 'checkbox' },
  { key: 'cancel_business_days', label: '変更・キャンセル期限（営業日前）', type: 'number', min: 0, required: true }, { key: 'cancel_cutoff_time', label: '変更・キャンセルの締切時刻', type: 'time', required: true }, { key: 'min_lead_business_days', label: '最短お届けまでの営業日数', type: 'number', min: 1, required: true }, { key: 'notification_email', label: '注文通知先メール', type: 'email' },
  { key: 'contact_phone', label: 'お問い合わせ電話番号', type: 'tel' }, { key: 'contact_email', label: 'お問い合わせメール', type: 'email' }, { key: 'contact_hours', label: 'お問い合わせ受付時間' },
  { key: 'invite_valid_days', label: '招待QRの標準有効日数', type: 'number', min: 1 }, { key: 'invite_default_max_uses', label: '招待QRの標準登録上限人数', type: 'number', min: 1 }, { key: 'edit_lock_minutes', label: '注文編集ロック（分）', type: 'number', min: 1 },
  { key: 'multi_parcel_discount_enabled', label: '複数個口割引を有効にする', type: 'checkbox' }, { key: 'multi_parcel_discount_amount', label: '複数個口の割引額（円）', type: 'number', min: 0 },
];

function SettingsForm({ type }: { type: 'company-info' | 'report-settings' | 'settings' }) {
  const [form, setForm] = useState<Row>({}); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const fields = type === 'company-info' ? companyFields : type === 'report-settings' ? reportFields : systemFields;
  useEffect(() => { let live = true; setLoading(true); setError(''); setSuccess(''); api<Row>(`/api/admin/${type}`).then(data => { if (live) setForm(data || {}); }).catch(e => { if (live) setError(errorText(e)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [type]);
  async function save(e: FormEvent) {
    e.preventDefault(); if (!window.confirm(type === 'company-info' ? '会社情報・振込口座を保存します。今後発行する帳票に反映されます。保存しますか？' : '設定の変更を保存しますか？')) return;
    setBusy(true); setError(''); setSuccess('');
    try { const payload = normalizeFields(form, fields); if (type === 'company-info' && payload.bank_account_number) payload.bank_account_number = String(payload.bank_account_number).padStart(7, '0'); if (type === 'settings') for (const field of fields) if (field.type === 'checkbox') payload[field.key] = payload[field.key] === 1 || payload[field.key] === 'true' || payload[field.key] === true ? 'true' : 'false'; await api(`/api/admin/${type}`, { method: 'PUT', body: JSON.stringify(payload) }); setSuccess('設定を保存しました。'); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  const title = type === 'company-info' ? '会社情報・振込口座' : type === 'report-settings' ? '帳票設定' : '税・注文・通知設定';
  return <section className="admin-card"><div className="admin-card-head"><div><h2>{title}</h2><p className="admin-muted">{type === 'company-info' ? '請求書・納品書に記載する発行元と振込先を設定します。' : type === 'report-settings' ? '帳票のタイトルや印字項目、備考の初期値を設定します。' : '税計算や注文期限、お問い合わせ先を設定します。価格は税抜で統一されます。'}</p></div>{type === 'company-info' ? <Landmark className="admin-muted" size={24} /> : <Settings2 className="admin-muted" size={24} />}</div><div className="master-settings-body"><Notice error={error} success={success} />{loading ? <div className="master-empty"><Loader2 className="master-spin" />設定を読み込み中…</div> : <form onSubmit={save}><Fields fields={fields} value={form} setValue={setForm} /><div className="master-form-actions"><span className="admin-muted">変更内容は監査ログに記録されます。</span><button className="admin-btn primary" disabled={busy}>{busy ? <Loader2 className="master-spin" size={17} /> : <Check size={17} />}{busy ? '保存中…' : '設定を保存'}</button></div></form>}</div></section>;
}

const actions: Record<string, string> = { ORDER_CREATE: '注文作成', ORDER_UPDATE: '注文変更', ORDER_STATUS_UPDATE: '注文ステータス変更', ORDER_CANCEL: '注文キャンセル', PRICE_UPDATE: '単価変更', INVOICE_ISSUE: '請求書発行', INVOICE_VOID: '請求書無効化', INVITE_CREATE: '招待QR発行', INVITE_REVOKE: '招待QR無効化', PRODUCT_CREATE: '商品登録', PRODUCT_UPDATE: '商品変更', SETTINGS_UPDATE: '設定変更', COMPANY_CREATE: '取引先登録', COMPANY_UPDATE: '取引先変更' };
function parseAudit(value: any) { if (!value) return {}; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return { 内容: value }; } }
function Audit() {
  const [rows, setRows] = useState<Row[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [query, setQuery] = useState(''); const [action, setAction] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [actor, setActor] = useState(''); const [selected, setSelected] = useState<Row | null>(null);
  const dialogRef = useModalFocus(selected !== null, () => setSelected(null));
  async function load(e?: FormEvent) { e?.preventDefault(); setLoading(true); setError(''); const params = new URLSearchParams(); if (query) params.set('q', query); if (action) params.set('action', action); try { setRows(list(await api(`/api/admin/audit?${params}`))); } catch (err) { setError(errorText(err)); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);
  const filtered = rows.filter(row => (!actor || row.actor_type === actor) && (!from || row.acted_at?.slice(0, 10) >= from) && (!to || row.acted_at?.slice(0, 10) <= to));
  const before = selected ? parseAudit(selected.before_json) : {}; const after = selected ? parseAudit(selected.after_json) : {}; const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const formatDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }); };
  return <><Notice error={error} /><section className="admin-card"><div className="admin-card-head"><div><h2>操作履歴</h2><p className="admin-muted">変更前後の内容と操作者を確認できます。ログは編集できません。</p></div><ShieldCheck size={24} className="admin-muted" /></div><form className="master-audit-filters" onSubmit={load}><label className="admin-field"><span>キーワード</span><input className="admin-input" placeholder="操作・対象・取引先を検索" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="admin-field"><span>操作種別</span><select className="admin-select" value={action} onChange={e => setAction(e.target.value)}><option value="">すべての操作</option>{Object.entries(actions).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label className="admin-field"><span>操作者</span><select className="admin-select" value={actor} onChange={e => setActor(e.target.value)}><option value="">すべて</option><option value="admin">管理者</option><option value="customer">お客様</option><option value="system">システム</option></select></label><label className="admin-field"><span>開始日</span><input className="admin-input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="admin-field"><span>終了日</span><input className="admin-input" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label><button className="admin-btn primary" disabled={loading}><Search size={17} />検索</button></form><div className="master-audit-summary"><span className="admin-muted">{filtered.length} 件の操作履歴</span><span className="admin-muted">日時は日本時間で表示</span></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>操作日時</th><th>操作者</th><th>操作内容</th><th>対象</th><th>変更内容</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="master-empty"><Loader2 className="master-spin" />履歴を読み込み中…</div></td></tr> : filtered.length ? filtered.map(row => <tr key={row.id}><td>{formatDate(row.acted_at)}</td><td><span className="master-actor-name">{row.actor_name || row.actor_id || 'システム'}</span><Badge value={row.actor_type} /></td><td><strong>{actions[row.action] || row.action}</strong><small className="master-small admin-muted">{row.note}</small></td><td>{row.company_name || row.target_name || row.target_type}<small className="master-small admin-muted">{row.target_id}</small></td><td><button className="admin-btn secondary" onClick={() => setSelected(row)}><FileText size={14} />詳細</button></td></tr>) : <tr><td colSpan={5}><div className="master-empty"><ShieldCheck size={30} /><strong>操作履歴がありません</strong><span className="admin-muted">登録・変更操作を行うと、ここに記録されます。</span></div></td></tr>}</tbody></table></div></section>
    {selected && <div className="master-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><section ref={dialogRef} tabIndex={-1} className="master-modal" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title"><header><div><span className="master-eyebrow">AUDIT LOG</span><h2 id="audit-detail-title">{actions[selected.action] || selected.action}</h2><p className="admin-muted">{formatDate(selected.acted_at)} ・ {selected.actor_name || selected.actor_id || 'システム'}</p></div><button className="admin-btn secondary master-icon-button" aria-label="閉じる" onClick={() => setSelected(null)}><X size={20} /></button></header><div className="master-modal-body"><div className="master-diff-heading"><span>変更前</span><ChevronRight size={18} /><span>変更後</span></div>{changedKeys.length ? changedKeys.map(key => <div className="master-diff-row" key={key}><strong>{[...productFields, ...companyFields, ...reportFields, ...systemFields].find(f => f.key === key)?.label || key}</strong><div><pre>{readable(before[key])}</pre><pre>{readable(after[key])}</pre></div></div>) : <p className="master-empty admin-muted">変更前後の詳細データはありません。</p>}{selected.note && <p className="master-audit-note">{selected.note}</p>}</div><footer><button className="admin-btn secondary" onClick={() => setSelected(null)}>閉じる</button></footer></section></div>}
  </>;
}

export default function Masters({ section, userRole }: { section: string; userRole?: string }) {
  const [shippingTab, setShippingTab] = useState('calendar'); const [settingsTab, setSettingsTab] = useState<'company-info' | 'settings' | 'report-settings' | 'line-rich-menu'>(() => new URLSearchParams(window.location.search).get('tab') === 'line-rich-menu' ? 'line-rich-menu' : 'company-info');
  const titles: Record<string, [string, string]> = { products: ['商品管理', '小島醸造のお酒と、商品に込めた想いを届ける。'], shipping: ['配送管理', '配送日・梱包・送料をまとめて管理します。'], settings: ['設定', '日々の業務にあわせて、システムの設定を整えます。'], audit: ['監査ログ', '大切な操作を、いつでも確認できるように。'] };
  const [title, subtitle] = titles[section] || titles.settings;
  return <div className="master-page"><div className="admin-page-head"><div><p className="master-eyebrow">KOJIMA BREWERY / {section.toUpperCase()}</p><h1>{title}</h1><p className="admin-muted">{subtitle}</p></div>{section === 'products' ? <span className="master-heading-icon"><Wine size={25} /></span> : section === 'shipping' ? <span className="master-heading-icon"><Truck size={25} /></span> : null}</div>
    {section === 'products' && <Resource config={productConfig} />}
    {section === 'shipping' && <><div className="admin-tabs master-tabs" role="tablist" aria-label="配送管理メニュー">{[['calendar', '配送カレンダー'], ['boxes', '梱包箱'], ['sizes', 'ヤマトサイズ'], ['rates', 'ヤマト運賃'], ['shipping-rules', '配送ルール']].map(([key, label]) => <button key={key} role="tab" aria-selected={shippingTab === key} className={`admin-tab ${shippingTab === key ? 'active' : ''}`} onClick={() => setShippingTab(key)}>{key === 'calendar' && <CalendarDays size={16} />}{label}</button>)}</div>{shippingTab === 'calendar' ? <DeliveryCalendar /> : <Resource key={shippingTab} config={shippingConfigs[shippingTab]} />}</>}
    {section === 'settings' && <><div className="admin-tabs master-tabs" role="tablist" aria-label="設定メニュー">{([['company-info', '会社情報・振込口座'], ['settings', '税・注文・通知'], ['report-settings', '帳票設定'], ['line-rich-menu', 'LINEリッチメニュー']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={settingsTab === key} className={`admin-tab ${settingsTab === key ? 'active' : ''}`} onClick={() => setSettingsTab(key)}>{label}</button>)}</div>{settingsTab === 'line-rich-menu' ? <RichMenu owner={userRole === 'owner'} /> : <SettingsForm key={settingsTab} type={settingsTab} />}</>}
    {section === 'audit' && <Audit />}
  </div>;
}
