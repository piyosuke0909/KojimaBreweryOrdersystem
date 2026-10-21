import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Wine, Boxes, CalendarDays, Check, ChevronLeft, ChevronRight, CircleAlert, Landmark, Loader2, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, Truck, X } from 'lucide-react';
import { api } from './api';
import { FieldHelp, navigableRowProps } from './ui';
import { isGoogleDriveUrl, parseGoogleDriveImage, resolveProductImageUrl } from '../../shared/product-image';
import RichMenu from './RichMenu';
import './masters.css';

type Row = Record<string, any>;
type Field = { key: string; label: string; type?: string; required?: boolean; options?: [string, string][]; hint?: string; help?: string; placeholder?: string; min?: number; max?: number; step?: string; wide?: boolean; pattern?: string };
type ResourceConfig = { path: string; title: string; singular: string; description: string; key?: string; fields: Field[]; defaults: Row; columns: { key: string; label: string; render?: (row: Row) => ReactNode }[] };
const yen = (value: unknown) => value === null || value === undefined || value === '' ? '未設定' : `¥${Number(value).toLocaleString('ja-JP')}`;
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const nowDate = () => dateKey(new Date());
const activeOptions: [string, string][] = [['active', '有効'], ['inactive', '無効']];
const productStatus: Record<string, string> = { on_sale: '販売中', suspended: '販売停止', unavailable: '注文不可' };
const errorText = (e: unknown) => e instanceof Error ? e.message : '処理に失敗しました。もう一度お試しください。';
const list = (data: any): Row[] => Array.isArray(data) ? data : data?.items || [];
const readable = (value: unknown) => typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—');
// Examples stay in placeholders: they must never become saved company or bank data.
const fieldGuidance: Record<string, { example?: string; help: string }> = {
  name: { example: '小島のしずく 700ml', help: '一覧や選択画面で区別できる名称を入力します。' },
  category: { example: '新酒・ガラス瓶', help: '商品を分類する表示用の区分です。空欄でも登録できます。' },
  volume_ml: { example: '700', help: '1本あたりの内容量をmlで入力します。対応する梱包箱の選定に使います。' },
  unit: { example: '本', help: '注文数量の単位です。「本」「セット」など、受注時に使う名称を入力します。' },
  standard_price: { example: '2800', help: '1販売単位あたりの標準卸価格を税抜の整数で入力します。取引先別の単価がある場合はそちらを優先します。空欄の商品は価格未設定のため注文できません。既存注文の単価は変わりません。' },
  weight_kg: { example: '1.2', help: '内容物と容器を含む1本の重量です。梱包箱の重量と合算し、宅急便のサイズ・送料を計算します。' },
  sales_status: { help: '「販売中」は注文可能、「販売停止」は一時的な販売休止、「注文不可」は注文対象外です。価格未設定など他の条件によっても注文が制限されます。' },
  sort_order: { example: '10', help: '注文画面の商品を小さい数字から順に並べます。同じ番号の場合は商品名順になります。' },
  image_url: { example: 'https://drive.google.com/file/d/ファイルID/view', help: 'Googleドライブの画像ファイルの共有リンク、HTTPSの画像URL、または /assets/ などサイト内の画像パスを入力します。Googleドライブは「一般的なアクセス」を「リンクを知っている全員」、権限を「閲覧者」にしてください。フォルダのリンクは使用できません。空欄の場合は「画像準備中」と表示します。' },
  short_description: { example: '米の旨みが広がる、すっきりとした純米酒。', help: '商品カードに表示する短い紹介文です。詳しい説明は下の商品紹介欄に入力します。' },
  description: { example: '愛知県産の米を使い、低温でじっくりと醸しました。', help: '商品の特徴・原料・製法などをお客様に伝える紹介文です。' },
  commitment: { example: '地元の米と水にこだわり、少量ずつ丁寧に仕込みます。', help: '蔵や造り手が大切にしていることを商品紹介に表示します。' },
  taste: { example: 'やわらかな香りと米の旨み、軽やかな後味。', help: '香り・甘辛・酸味・余韻など、お酒を選ぶときに役立つ味わいを記載します。' },
  recommended_way: { example: '冷酒で。白身魚のお刺身や湯豆腐と一緒に。', help: 'おすすめの温度や、よく合う料理を商品紹介に表示します。' },
  is_limited: { help: '商品に「業者限定」の表示を付けます。表示設定であり、特定の取引先だけに閲覧権限を付与する機能ではありません。' },
  note: { example: '次回の運賃改定時に内容を確認する。', help: '管理者が確認するための補足です。注文や帳票の備考とは別の管理用メモです。' },
  supported_volumes_json: { example: '300, 500, 700', help: 'この箱に梱包できる商品の容量をmlで指定します。複数ある場合はカンマで区切ります。' },
  max_bottles: { example: '6', help: '1箱に入れられる商品の最大本数です。超える注文は複数の箱に分けて計算します。' },
  length_cm: { example: '30', help: '梱包後の箱の縦の長さをcmで入力します。縦・横・高さの合計で宅急便サイズを判定します。' },
  width_cm: { example: '24', help: '梱包後の箱の横の長さをcmで入力します。' },
  height_cm: { example: '36', help: '梱包後の箱の高さをcmで入力します。' },
  box_weight_kg: { example: '0.3', help: '空箱と緩衝材の合計重量です。商品の重量に加算されます。' },
  target_condition: { example: 'ガラス瓶用・仕切り付き', help: '対応する商品の補足を記録する欄です。自動選定は対応容量・最大本数・寸法・重量などの設定に基づきます。' },
  allow_mixed: { help: '有効にすると、対応容量の範囲で異なる容量の商品を同じ箱に梱包できます。' },
  priority: { example: '10', help: '箱を選定する際の優先順位です。小さい数字を優先します。' },
  valid_from: { example: '2026-11-01', help: 'この日から設定を適用します。空欄の場合は開始日を制限しません。' },
  valid_to: { example: '2027-03-31', help: 'この日まで設定を適用します。空欄の場合は終了日を制限しません。' },
  status: { help: '「有効」は今後の自動計算・選択に使用し、「無効」は使用を停止します。過去の注文や帳票は保持されます。' },
  size_code: { help: '宅急便のサイズ区分です。編集時は変更できません。別のサイズを追加する場合は新規登録します。' },
  max_three_sides_cm: { example: '100', help: '箱の縦・横・高さを足した長さの上限です。重量上限と両方を満たす最小サイズが選ばれます。' },
  max_weight_kg: { example: '10', help: '商品・容器・箱・緩衝材をすべて含む重量の上限です。' },
  origin_region: { example: '中部', help: '発送元の運賃地域です。通常は蔵の所在地に対応した地域名を指定します。' },
  dest_region: { example: '愛知県', help: '配送先住所の都道府県名と一致する名称を入力します。例：愛知県、東京都、北海道。' },
  shipping_fee: { example: '1100', help: '地域・サイズ1個口あたりの送料を税抜の整数で入力します。送料への課税は「税・注文・通知」で設定します。' },
  rate_type: { help: '該当する契約運賃がある場合は一般運賃より優先します。配送会社との契約内容に合わせて登録します。' },
  delivery_method: { help: '「自社配達」は蔵から配達し送料無料、「ヤマト宅急便」は箱・サイズ・運賃の設定から送料を計算します。' },
  target_condition_json: { example: '犬山市, 江南市', help: 'このルールを適用する市区町村名をカンマで区切ります。空欄はすべての地域が対象です。配送先住所に登録された名称に合わせます。' },
  allowed_periods_json: { example: '1-7, 15-22', help: '毎月1〜7日と15〜22日に配送する場合は「1-7, 15-22」と入力します。空欄の場合、日付の範囲を制限しません。営業日やリードタイムの制限は別途適用されます。' },
  is_free_shipping: { help: 'この配送ルールの送料を0円にします。自社配達を選ぶ場合は必ず有効になります。' },
  is_deliverable: { help: 'その日の個別の配送可否です。オフにすると配送不可日になります。配送ルールや最短お届けまでの日数などの条件も合わせて判定します。' },
  reason: { help: '配送不可として表示する理由です。配送可能の日は指定しなくても構いません。' },
  company_name: { example: '小島醸造株式会社', help: '帳票の発行元となる正式な会社名です。ここに表示する例は入力見本のため、実際の登記名に置き換えてください。' },
  display_name: { example: '小島醸造', help: '請求書・納品書の発行元に表示する名称です。正式名称を表示したい場合は会社名と同じ内容を入力します。' },
  postal_code: { example: '484-0000', help: '発行元の郵便番号です。半角数字で、ハイフン付きでも入力できます。' },
  address: { example: '愛知県犬山市○○町1-2-3', help: '請求書・納品書に記載する会社の所在地です。番地や建物名まで入力します。' },
  tel: { example: '0568-00-0000', help: '発行元の代表電話番号です。帳票や問い合わせ対応に使う番号を入力します。' },
  fax: { example: '0568-00-0001', help: '会社のFAX番号です。帳票設定でFAX表示を有効にすると帳票に記載します。利用しない場合は空欄にします。' },
  email: { example: 'info@example.jp', help: '会社の代表メールアドレスです。帳票設定でメール表示を有効にすると帳票に記載します。' },
  contact_person: { example: '小島 太郎', help: '帳票に表示する発行元の担当者名です。表示の有無は帳票設定で指定します。' },
  invoice_reg_no: { example: 'T1234567890123', help: '適格請求書発行事業者の登録番号を、半角のTと13桁の数字で入力します。必ず実際の登録番号を確認してください。' },
  bank_name: { example: '○○銀行', help: '請求書に記載する振込先の銀行名です。例をそのまま使わず、実際の振込先を入力してください。' },
  bank_branch_name: { example: '犬山支店', help: '振込先口座の支店名です。銀行に登録された名称を入力します。' },
  bank_account_type: { help: '振込先の預金種別です。普通預金または当座預金を、実際の口座に合わせて選びます。' },
  bank_account_number: { example: '0123456', help: '半角数字6〜7桁の口座番号を入力します。6桁の場合は保存時に先頭へ0を付けて7桁にそろえます。' },
  bank_account_holder: { example: 'コジマジョウゾウ（カ', help: '金融機関に登録された振込先の口座名義をカナで入力します。株式会社などの略称・記号も登録内容と一致させてください。' },
  delivery_note_title: { example: '納品書', help: '納品書の先頭に印字する表題です。' },
  invoice_title: { example: '御請求書', help: '請求書の先頭に印字する表題です。' },
  numbering_rule: { example: 'OYYYYMMDDNNNN,INVYYYYMMNNN', help: '採番形式の管理用設定です。YYYYは年、MMは月、DDは日、Nは連番を表す記法です。現在の注文・請求書番号の生成形式はシステム側で固定されており、この欄だけでは変更されません。' },
  show_issuer_info: { help: '帳票に会社名・住所などの発行元情報を表示します。内容は「会社情報・振込口座」で登録します。' },
  show_invoice_reg_no: { help: '帳票に適格請求書発行事業者登録番号を表示します。会社情報に正しい番号を登録してください。' },
  show_contact_person: { help: '帳票に発行元の担当者名を表示します。' },
  show_fax: { help: '帳票に会社情報のFAX番号を表示します。' },
  show_email: { help: '帳票に会社情報のメールアドレスを表示します。' },
  delivery_note_template: { example: '商品をご確認のうえ、相違がございましたらご連絡ください。', help: '納品書の備考に使う定型文です。個別注文の備考とは別に管理します。' },
  invoice_note_template: { example: '振込手数料は貴社にてご負担くださいますようお願いいたします。', help: '請求書の備考に使う定型文です。振込や支払いについての案内を記載します。' },
  tax_rate: { example: '10', help: '税抜の商品金額に適用する消費税率です。10%の場合は「10」と入力します。0〜100の整数で設定します。酒類の軽減税率の扱いに注意し、実際の取引に合わせて設定してください。' },
  tax_calc_unit: { help: '「請求単位」は請求書発行時に税率ごとの合計額から計算し、注文画面の税額は参考値になります。「注文単位」は注文ごと、「明細単位」は商品明細ごとに端数処理して合計します。' },
  tax_rounding: { help: '税額の1円未満の端数を処理する方法です。例：税額100.5円は、切り捨て100円、切り上げ101円、四捨五入101円になります。' },
  shipping_taxable: { help: '有効にすると、配送料にも設定税率で消費税を加算します。無効にすると配送料を税計算の対象から外します。' },
  cancel_business_days: { example: '2', help: 'お届け日の何営業日前まで変更・キャンセルを受け付けるかを指定します。休業日は営業日数から除き、締切時刻と合わせて判定します。' },
  cancel_cutoff_time: { example: '17:00', help: '変更・キャンセルを受け付ける最終日の締切時刻です。日本時間の24時間表記で設定します。' },
  min_lead_business_days: { example: '3', help: '注文から配送までに必要な営業日数です。休業日や配送ルールも考慮して、選択できるお届け日を決めます。0は当日を許容する設定です。' },
  notification_email: { example: 'orders@example.jp', help: '注文通知の宛先として登録するメールアドレスです。通知メールの実際の送信には、環境側のメール連携設定も必要です。' },
  contact_phone: { example: '0568-00-0000', help: 'お客様に案内するお問い合わせ先の電話番号です。' },
  contact_email: { example: 'support@example.jp', help: 'お客様に案内するお問い合わせ用メールアドレスです。' },
  contact_hours: { example: '平日 9:00〜17:00（土日祝休み）', help: 'お客様に表示するお問い合わせの受付時間です。電話対応できる曜日・時間を入力します。' },
  invite_valid_days: { example: '30', help: '招待QRを新規発行するときの標準有効日数です。発行済みのQRの有効期限は変わりません。' },
  invite_default_max_uses: { example: '5', help: '1つの招待QRから登録できるLINE担当者数の初期値です。同じ取引先でも、担当者ごとに自分のLINEアカウントで登録します。' },
  edit_lock_minutes: { example: '10', help: '同じ注文を同時に変更しないための編集ロックの保持時間です。1〜60分で設定します。' },
  multi_parcel_discount_enabled: { help: 'ヤマト宅急便が複数個口となった場合に、設定した複数個口割引を適用します。' },
  multi_parcel_discount_amount: { example: '100', help: '複数個口になった場合の1個口あたりの割引額です。割引が有効なときに送料から差し引き、送料は0円未満にはなりません。' },
};

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
      if (event.target instanceof Element && event.target.closest('.admin-help-popover')) return;
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

function ProductThumbnail({ product }: { product: Row }) {
  const source = resolveProductImageUrl(product.image_url);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <span className="master-product-icon">{source && source !== failedSource ? <img key={source} src={source} alt={`${product.name}の商品画像`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedSource(source)} /> : <Wine size={23} />}</span>;
}

type ImagePreviewState = { source: string; status: 'idle' | 'loading' | 'ready' | 'error'; url?: string; error?: string };
function ProductImagePreview({ value }: { value: string }) {
  const source = value.trim();
  const [preview, setPreview] = useState<ImagePreviewState>({ source, status: 'idle' });
  const requestVersion = useRef(0), controller = useRef<AbortController | null>(null), objectUrl = useRef<string | null>(null);
  const releaseObjectUrl = () => { if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; } };
  useEffect(() => {
    requestVersion.current += 1; controller.current?.abort(); releaseObjectUrl();
    setPreview({ source, status: 'idle' });
    return () => { requestVersion.current += 1; controller.current?.abort(); releaseObjectUrl(); };
  }, [source]);
  const current = preview.source === source ? preview : null;
  async function check() {
    if (!source) return;
    const version = ++requestVersion.current;
    controller.current?.abort(); releaseObjectUrl();
    const requestController = new AbortController(); controller.current = requestController;
    setPreview({ source, status: 'loading' });
    try {
      let url: string;
      if (isGoogleDriveUrl(source)) {
        if (!parseGoogleDriveImage(source)) throw new Error('Googleドライブの画像ファイルの共有リンクを入力してください。フォルダのリンクは使用できません。');
        const response = await fetch('/api/admin/product-image-preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ image_url: source }), signal: requestController.signal });
        if (!response.ok) {
          let message = '画像を確認できませんでした。Googleドライブの共有設定と画像ファイルをご確認ください。';
          try { const body = await response.json() as { error?: { message?: unknown } }; if (typeof body.error?.message === 'string') message = body.error.message; } catch { /* Keep the safe explanation when the server response is not JSON. */ }
          throw new Error(message);
        }
        if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('image/')) throw new Error('画像ファイルを確認できませんでした。画像ファイルの共有リンクをご確認ください。');
        const blob = await response.blob();
        if (version !== requestVersion.current || requestController.signal.aborted) return;
        url = URL.createObjectURL(blob); objectUrl.current = url;
      } else {
        const internal = source.startsWith('/') && !source.startsWith('//') && !source.includes('\\');
        let https = false;
        try { const parsed = new URL(source); https = parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { /* Internal paths do not need an absolute URL. */ }
        if (!internal && !https) throw new Error('Googleドライブの共有リンク、HTTPSの画像URL、またはサイト内の画像パスを入力してください。');
        url = resolveProductImageUrl(source);
      }
      if (version === requestVersion.current && !requestController.signal.aborted) setPreview({ source, status: 'loading', url });
    } catch (error) {
      if (version === requestVersion.current && !requestController.signal.aborted) setPreview({ source, status: 'error', error: errorText(error) });
    }
  }
  if (!source) return null;
  return <div className="master-image-preview">
    <button type="button" className="admin-btn secondary" disabled={current?.status === 'loading'} onClick={() => void check()}>{current?.status === 'loading' ? <Loader2 size={16} className="master-spin" /> : null}画像を確認</button>
    {current?.status === 'loading' && <span className="admin-muted" role="status">画像を確認しています…</span>}
    {current?.url && current.status !== 'error' && <img key={current.url} src={current.url} alt="商品画像のプレビュー" referrerPolicy="no-referrer" onLoad={() => setPreview(old => old.source === source && old.url === current.url ? { ...old, status: 'ready' } : old)} onError={() => setPreview(old => old.source === source && old.url === current.url ? { source, status: 'error', error: '画像を読み込めません。URL、共有設定、画像ファイルをご確認ください。' } : old)} />}
    {current?.status === 'error' && <p className="master-image-preview-error" role="alert">{current.error}</p>}
  </div>;
}

function Fields({ fields, value, setValue, lockedKey }: { fields: Field[]; value: Row; setValue: (v: Row) => void; lockedKey?: string }) {
  return <div className="admin-form-grid">{fields.map(field => {
    const id = `master-${field.key}`;
    const common = { id, name: field.key, required: field.required, disabled: lockedKey === field.key, className: field.options ? 'admin-select' : 'admin-input' };
    const guidance = fieldGuidance[field.key];
    const help = field.help || guidance?.help || `${field.label}を入力します。`;
    const placeholder = field.placeholder || guidance?.example;
    const caption = <><FieldHelp label={field.label} help={help} />{field.required && <span className="master-required">必須</span>}</>;
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
      {field.type === 'checkbox' ? <label className="master-checkbox"><input id={id} type="checkbox" checked={val === true || val === 1 || val === 'true'} onChange={e => setValue({ ...value, [field.key]: e.target.checked ? 1 : 0 })} />{caption}</label> : <><label htmlFor={id}>{caption}</label>
        {field.options ? <select {...common} value={String(val)} onChange={e => setValue({ ...value, [field.key]: e.target.value })}>{!field.required && <option value="">選択してください</option>}{field.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
          : field.type === 'textarea' || field.type === 'json' ? <textarea {...common} placeholder={placeholder ? `例：${placeholder}` : undefined} rows={field.type === 'json' ? 3 : 4} value={typeof val === 'object' ? JSON.stringify(val, null, 2) : val} onChange={e => setValue({ ...value, [field.key]: e.target.value })} />
            : <input {...common} placeholder={placeholder ? `例：${placeholder}` : undefined} type={['volumes', 'cities', 'periods'].includes(field.type || '') ? 'text' : field.type || 'text'} min={field.min} max={field.max} step={field.step || (field.type === 'number' ? '1' : undefined)} pattern={field.pattern} value={displayed} onChange={e => setValue({ ...value, [field.key]: field.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} />}</>}
      {field.hint && <small className="admin-muted">{field.hint}</small>}
      {field.key === 'image_url' && <ProductImagePreview value={String(val)} />}
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
  { key: 'image_url', label: '商品画像URL / アセットパス', wide: true, hint: 'Googleドライブは「一般的なアクセス → リンクを知っている全員 → 閲覧者」で共有してください。' }, { key: 'short_description', label: '短い商品説明', wide: true, hint: '注文画面の商品カードに表示されます。' },
  { key: 'description', label: '商品紹介 ① 商品説明', type: 'textarea' }, { key: 'commitment', label: '商品紹介 ② こだわり', type: 'textarea' },
  { key: 'taste', label: '商品紹介 ③ 味わい', type: 'textarea' }, { key: 'recommended_way', label: '商品紹介 ④ おすすめの飲み方', type: 'textarea' },
  { key: 'is_limited', label: '業者限定商品として表示する', type: 'checkbox' }, { key: 'note', label: '管理用メモ', type: 'textarea' },
];
const productConfig: ResourceConfig = {
  path: 'products', title: '商品一覧', singular: '商品', description: '標準卸価格や販売状態、LINEに表示する商品紹介を管理します。',
  fields: productFields, defaults: { name: '', category: '', volume_ml: 700, unit: '本', standard_price: '', weight_kg: '', tax_type: 'excl', sales_status: 'unavailable', is_limited: 0, sort_order: 0 },
  columns: [
    { key: 'name', label: '商品名', render: r => <div className="master-product-cell"><ProductThumbnail product={r} /><span><strong>{r.name}</strong><small className="admin-muted">{r.category || '区分未設定'}{r.is_limited ? ' ・ 業者限定' : ''}</small></span></div> },
    { key: 'volume_ml', label: '容量', render: r => `${Number(r.volume_ml).toLocaleString()} ml` }, { key: 'standard_price', label: '標準卸価格（税抜）', render: r => <strong>{yen(r.standard_price)}</strong> },
    { key: 'weight_kg', label: '重量', render: r => `${r.weight_kg} kg` }, { key: 'sales_status', label: '販売状態', render: r => <Badge value={r.sales_status} /> },
  ],
};

const shippingConfigs: Record<string, ResourceConfig> = {
  boxes: {
    path: 'boxes', title: '梱包箱', singular: '梱包箱', description: '商品容量・本数・重量から、適切な梱包箱を自動選定します。', defaults: { supported_volumes_json: '[300,500,700]', max_bottles: 6, box_weight_kg: 0.3, allow_mixed: 1, priority: 10, status: 'active', valid_from: nowDate() },
    fields: [
      { key: 'name', label: '箱名', required: true, placeholder: '700ml 6本用箱' }, { key: 'supported_volumes_json', label: '対応容量（ml）', type: 'volumes', required: true, hint: '複数ある場合はカンマで区切ります。例：300, 500, 700' },
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
    fields: [{ key: 'name', label: 'ルール名', required: true, placeholder: '犬山市内 自社配達' }, { key: 'delivery_method', label: '配送方法', required: true, options: [['own_delivery', '自社配達'], ['yamato', 'ヤマト宅急便']] }, { key: 'target_condition_json', label: '対象の市区町村', type: 'cities', hint: '例：犬山市, 江南市。空欄の場合はすべての地域が対象です。' }, { key: 'allowed_periods_json', label: '毎月の配送可能期間', type: 'periods', hint: '例：1-7, 15-22（毎月1〜7日と15〜22日）。空欄の場合は日付を制限しません。' }, { key: 'is_free_shipping', label: '送料無料とする', type: 'checkbox' }, { key: 'status', label: '状態', required: true, options: activeOptions }, { key: 'note', label: '管理用メモ', type: 'textarea' }],
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
  async function remove() {
    if (!original || busy) return;
    if (!window.confirm(`${original.name || original[idKey]} を削除します。今後の一覧・選択候補から外れます。過去の注文・帳票と監査履歴は保持されます。削除しますか？`)) return;
    setBusy(true); setFormError('');
    try {
      await api(`/api/admin/${config.path}/${encodeURIComponent(String(original[idKey]))}`, { method: 'DELETE' });
      setEditor(null); setSuccess(`${config.singular}を一覧から削除しました。過去の履歴は保持されています。`); await refresh();
    } catch (e) { setFormError(errorText(e)); } finally { setBusy(false); }
  }
  return <>
    <Notice error={error} success={success} />
    <section className="admin-card">
      <div className="admin-card-head"><div><h2>{config.title}</h2><p className="admin-muted">{config.description}</p></div><button className="admin-btn primary" onClick={() => edit()}><Plus size={17} />{config.singular}を追加</button></div>
      <div className="master-toolbar"><label className="master-search"><Search size={18} /><input aria-label={`${config.singular}を検索`} placeholder={`${config.singular}を検索…`} value={query} onChange={e => setQuery(e.target.value)} /></label><select className="admin-select" value={filter} onChange={e => setFilter(e.target.value)} aria-label="状態で絞り込む"><option value="all">すべての状態</option>{(config.path === 'products' ? Object.entries(productStatus) : activeOptions).map(([v, label]) => <option value={v} key={v}>{label}</option>)}</select><button className="admin-btn secondary master-icon-button" onClick={() => void refresh()} disabled={loading} aria-label="一覧を再読み込み"><RefreshCw size={17} className={loading ? 'master-spin' : ''} /></button><span className="admin-muted master-count">{filtered.length} 件</span></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{config.columns.map(c => <th key={c.key}>{c.label}</th>)}<th>操作</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={config.columns.length + 1}><div className="master-empty"><Loader2 className="master-spin" size={22} />読み込み中…</div></td></tr> : filtered.length ? filtered.map(r => <tr key={r[idKey]} {...navigableRowProps(() => edit(r), `${r.name || r.dest_region || r[idKey]}を編集`)}>{config.columns.map(c => <td key={c.key}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}<td><button className="admin-btn secondary" onClick={() => edit(r)}>編集</button></td></tr>) : <tr><td colSpan={config.columns.length + 1}><div className="master-empty"><Boxes size={30} /><strong>{query || filter !== 'all' ? '条件に合うデータがありません' : `${config.singular}がまだ登録されていません`}</strong><span className="admin-muted">{query || filter !== 'all' ? '検索条件を変更してください。' : `「${config.singular}を追加」から登録してください。`}</span></div></td></tr>}
      </tbody></table></div>
    </section>
    {editor && <div className="master-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setEditor(null); }}><section ref={dialogRef} tabIndex={-1} className="master-modal" role="dialog" aria-modal="true" aria-labelledby="master-editor-title"><header><div><span className="master-eyebrow">MASTER DATA</span><h2 id="master-editor-title">{config.singular}を{original ? '編集' : '追加'}</h2></div><button className="admin-btn secondary master-icon-button" aria-label="閉じる" onClick={() => setEditor(null)} disabled={busy}><X size={20} /></button></header><form onSubmit={save}><div className="master-modal-body"><Notice error={formError} /><Fields fields={config.fields} value={editor} setValue={setEditor} lockedKey={original ? config.key : undefined} /></div><footer>{original ? <button className="admin-btn danger master-delete-button" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />削除する</button> : <span className="admin-muted">変更内容は監査ログに記録されます。</span>}<button className="admin-btn secondary" type="button" disabled={busy} onClick={() => setEditor(null)}>キャンセル</button><button className="admin-btn primary" disabled={busy} type="submit">{busy ? <Loader2 className="master-spin" size={17} /> : <Check size={17} />}{busy ? '保存中…' : '保存する'}</button></footer></form></section></div>}
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
    try {
      const existing = indexed.has(selected.date);
      await api(`/api/admin/calendar${existing ? `/${encodeURIComponent(selected.date)}` : ''}`, { method: existing ? 'PUT' : 'POST', body: JSON.stringify(selected) });
      setSuccess(`${selected.date} の配送設定を保存しました。`); setSelected(null); await refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!selected || busy || !indexed.has(selected.date)) return;
    if (!window.confirm(`${selected.date} の個別設定を削除し、通常の配送ルールによる判定に戻しますか？過去の注文・監査履歴は保持されます。`)) return;
    setBusy(true); setError('');
    try {
      await api(`/api/admin/calendar/${encodeURIComponent(selected.date)}`, { method: 'DELETE' });
      setSuccess(`${selected.date} の個別設定を削除し、通常ルールに戻しました。`); setSelected(null); await refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <><Notice error={error} success={success} /><section className="admin-card"><div className="admin-card-head"><div><h2>配送カレンダー</h2><p className="admin-muted">日付を選択して配送可否や休業理由を設定します。</p></div><div className="master-month-nav"><button className="admin-btn secondary master-icon-button" onClick={() => move(-1)} aria-label="前月"><ChevronLeft size={18} /></button><strong>{month.getFullYear()}年 {month.getMonth() + 1}月</strong><button className="admin-btn secondary master-icon-button" onClick={() => move(1)} aria-label="翌月"><ChevronRight size={18} /></button><button className="admin-btn secondary" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>今月</button></div></div><div className="master-calendar-legend"><span><i className="master-dot good" />配送可能</span><span><i className="master-dot closed" />配送不可</span><span><i className="master-dot" />通常の配送ルール</span></div>
      {loading ? <div className="master-empty"><Loader2 className="master-spin" />カレンダーを読み込み中…</div> : <div className="master-calendar"><div className="master-calendar-week">{['日', '月', '火', '水', '木', '金', '土'].map((d, i) => <span className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''} key={d}>{d}</span>)}</div><div className="master-calendar-grid">{Array.from({ length: slots }, (_, index) => { const day = index - month.getDay() + 1; if (day < 1 || day > count) return <div className="master-calendar-blank" key={index} />; const date = dateKey(new Date(month.getFullYear(), month.getMonth(), day)); const entry = indexed.get(date); return <button key={date} className={`master-calendar-day ${entry ? entry.is_deliverable ? 'deliverable' : 'closed' : ''} ${selected?.date === date ? 'selected' : ''} ${date === nowDate() ? 'today' : ''}`} onClick={() => setSelected(entry ? { ...entry } : { date, is_deliverable: 1, reason: '', note: '' })} aria-label={`${date} ${entry ? entry.is_deliverable ? '配送可能' : `配送不可 ${entry.reason || ''}` : '通常ルール'}`}><span className={index % 7 === 0 ? 'sun' : index % 7 === 6 ? 'sat' : ''}>{day}</span><small>{entry ? entry.is_deliverable ? '配送可能' : entry.reason || '配送不可' : '通常ルール'}</small></button>; })}</div></div>}
      <p className="admin-muted master-calendar-footnote">「通常ルール」の日は、配送ルール・営業日・リードタイムに基づいて注文可否を判定します。</p>
    </section>
    {selected && <section className="admin-card master-day-editor"><div className="admin-card-head"><div><h2>{selected.date} の配送設定</h2><p className="admin-muted">個別の可否と、配送ルール・必要営業日数を合わせて判定します。個別設定を削除すると通常ルールに戻ります。</p></div><button className="admin-btn secondary master-icon-button" onClick={() => setSelected(null)} disabled={busy} aria-label="日付の編集を閉じる"><X size={18} /></button></div><form onSubmit={save}><Fields value={selected} setValue={setSelected} fields={[{ key: 'is_deliverable', label: 'この日は配送可能', type: 'checkbox' }, { key: 'reason', label: '配送不可理由', options: [['定休日', '定休日'], ['イベント出店', 'イベント出店'], ['休業日', '休業日'], ['その他', 'その他']] }, { key: 'note', label: '管理用メモ', type: 'textarea' }]} /><div className="master-form-actions">{indexed.has(selected.date) && <button className="admin-btn danger master-delete-button" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />この日の個別設定を削除</button>}<button className="admin-btn primary" disabled={busy}>{busy ? <Loader2 size={17} className="master-spin" /> : <Check size={17} />}この日の設定を保存</button></div></form></section>}
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
  { key: 'tax_rate', label: '消費税率（%）', type: 'number', min: 0, max: 100, step: '1', required: true }, { key: 'tax_calc_unit', label: '税計算単位', required: true, options: [['invoice', '請求単位'], ['order', '注文単位'], ['item', '明細単位']] },
  { key: 'tax_rounding', label: '消費税の端数処理', required: true, options: [['floor', '切り捨て'], ['ceil', '切り上げ'], ['round', '四捨五入']] }, { key: 'shipping_taxable', label: '配送料を課税対象にする', type: 'checkbox' },
  { key: 'cancel_business_days', label: '変更・キャンセル期限（営業日前）', type: 'number', min: 0, max: 365, required: true }, { key: 'cancel_cutoff_time', label: '変更・キャンセルの締切時刻', type: 'time', required: true }, { key: 'min_lead_business_days', label: '最短お届けまでの営業日数', type: 'number', min: 0, max: 365, required: true }, { key: 'notification_email', label: '注文通知先メール', type: 'email' },
  { key: 'contact_phone', label: 'お問い合わせ電話番号', type: 'tel' }, { key: 'contact_email', label: 'お問い合わせメール', type: 'email' }, { key: 'contact_hours', label: 'お問い合わせ受付時間' },
  { key: 'invite_valid_days', label: '招待QRの標準有効日数', type: 'number', min: 1, max: 3650 }, { key: 'invite_default_max_uses', label: '招待QRの標準登録上限人数', type: 'number', min: 1, max: 10000 }, { key: 'edit_lock_minutes', label: '注文編集ロック（分）', type: 'number', min: 1, max: 60 },
  { key: 'multi_parcel_discount_enabled', label: '複数個口割引を有効にする', type: 'checkbox' }, { key: 'multi_parcel_discount_amount', label: '複数個口の割引額（円）', type: 'number', min: 0, max: 1000000 },
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

const actions: Record<string, string> = { ORDER_CREATE: '注文作成', ORDER_UPDATE: '注文変更', ORDER_STATUS_UPDATE: '注文ステータス変更', ORDER_STATUS_CHANGE: '注文ステータス変更', ORDER_CANCEL: '注文キャンセル', PRICE_UPDATE: '単価変更', INVOICE_ISSUE: '請求書発行', INVOICE_VOID: '請求書無効化', INVITE_CREATE: '招待QR発行', INVITE_REVOKE: '招待QR無効化', PRODUCT_CREATE: '商品登録', PRODUCT_UPDATE: '商品変更', SETTINGS_UPDATE: '設定変更', COMPANY_CREATE: '取引先登録', COMPANY_UPDATE: '取引先変更', COMPANY_DELETE: '取引先削除', PRODUCT_DELETE: '商品削除', SHIPPING_RULE_DELETE: '配送ルール削除', CALENDAR_DELETE: '配送日削除', PACKAGING_DELETE: '梱包設定削除', YAMATO_RATE_DELETE: '運賃削除', ADDRESS_DELETE: '配送先削除', CONTRACT_DELETE: '契約削除', PRICE_DELETE: '単価削除', INVITE_DELETE: '招待QR削除' };
function parseAudit(value: any) { if (!value) return {}; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return { 内容: value }; } }
function Audit() {
  const [rows, setRows] = useState<Row[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [query, setQuery] = useState(''); const [action, setAction] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [actor, setActor] = useState(''); const [selected, setSelected] = useState<Row | null>(null);
  const dialogRef = useModalFocus(selected !== null, () => setSelected(null));
  async function load(e?: FormEvent) { e?.preventDefault(); setLoading(true); setError(''); const params = new URLSearchParams(); if (query) params.set('q', query); if (action) params.set('action', action); try { setRows(list(await api(`/api/admin/audit?${params}`))); } catch (err) { setError(errorText(err)); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);
  const filtered = rows.filter(row => (!actor || row.actor_type === actor) && (!from || row.acted_at?.slice(0, 10) >= from) && (!to || row.acted_at?.slice(0, 10) <= to));
  const before = selected ? parseAudit(selected.before_json) : {}; const after = selected ? parseAudit(selected.after_json) : {}; const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const formatDate = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }); };
  return <><Notice error={error} /><section className="admin-card"><div className="admin-card-head"><div><h2>操作履歴</h2><p className="admin-muted">変更前後の内容と操作者を確認できます。ログは編集できません。</p></div><ShieldCheck size={24} className="admin-muted" /></div><form className="master-audit-filters" onSubmit={load}><label className="admin-field"><span>キーワード</span><input className="admin-input" placeholder="操作・対象・取引先を検索" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="admin-field"><span>操作種別</span><select className="admin-select" value={action} onChange={e => setAction(e.target.value)}><option value="">すべての操作</option>{Object.entries(actions).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label className="admin-field"><span>操作者</span><select className="admin-select" value={actor} onChange={e => setActor(e.target.value)}><option value="">すべて</option><option value="admin">管理者</option><option value="customer">お客様</option><option value="system">システム</option></select></label><label className="admin-field"><span>開始日</span><input className="admin-input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="admin-field"><span>終了日</span><input className="admin-input" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label><button className="admin-btn primary" disabled={loading}><Search size={17} />検索</button></form><div className="master-audit-summary"><span className="admin-muted">{filtered.length} 件の操作履歴</span><span className="admin-muted">日時は日本時間で表示</span></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>操作日時</th><th>操作者</th><th>操作内容</th><th>対象</th><th>変更内容</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="master-empty"><Loader2 className="master-spin" />履歴を読み込み中…</div></td></tr> : filtered.length ? filtered.map(row => <tr key={row.id} {...navigableRowProps(() => setSelected(row), `${actions[row.action] || row.action}の内容を確認`)}><td>{formatDate(row.acted_at)}</td><td><span className="master-actor-name">{row.actor_name || row.actor_id || 'システム'}</span><Badge value={row.actor_type} /></td><td><strong>{actions[row.action] || row.action}</strong><small className="master-small admin-muted">{row.note}</small></td><td>{row.company_name || row.target_name || row.target_type}<small className="master-small admin-muted">{row.target_id}</small></td><td><button className="admin-btn secondary" onClick={() => setSelected(row)}>内容を確認</button></td></tr>) : <tr><td colSpan={5}><div className="master-empty"><ShieldCheck size={30} /><strong>操作履歴がありません</strong><span className="admin-muted">登録・変更操作を行うと、ここに記録されます。</span></div></td></tr>}</tbody></table></div></section>
    {selected && <div className="master-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><section ref={dialogRef} tabIndex={-1} className="master-modal" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title"><header><div><span className="master-eyebrow">AUDIT LOG</span><h2 id="audit-detail-title">{actions[selected.action] || selected.action}</h2><p className="admin-muted">{formatDate(selected.acted_at)} ・ {selected.actor_name || selected.actor_id || 'システム'}</p></div><button className="admin-btn secondary master-icon-button" aria-label="閉じる" onClick={() => setSelected(null)}><X size={20} /></button></header><div className="master-modal-body"><div className="master-diff-heading"><span>変更前</span><span>変更後</span></div>{changedKeys.length ? changedKeys.map(key => <div className="master-diff-row" key={key}><strong>{[...productFields, ...companyFields, ...reportFields, ...systemFields].find(f => f.key === key)?.label || key}</strong><div><pre>{readable(before[key])}</pre><pre>{readable(after[key])}</pre></div></div>) : <p className="master-empty admin-muted">変更前後の詳細データはありません。</p>}{selected.note && <p className="master-audit-note">{selected.note}</p>}</div><footer><button className="admin-btn secondary" onClick={() => setSelected(null)}>閉じる</button></footer></section></div>}
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
