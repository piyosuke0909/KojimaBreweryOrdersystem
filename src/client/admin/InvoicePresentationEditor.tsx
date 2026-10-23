import type { FormEvent } from 'react';
import { Eye, RotateCcw, Save } from 'lucide-react';

type Row = Record<string, any>;
export type InvoicePresentation = {
  title: string; recipient_name: string; recipient_address: string; due_date: string | null; note: string;
  issuer: Record<string, string>;
};
const issuerFields = [
  ['display_name', '発行元の表示名', 200, '例：小島醸造'],
  ['company_name', '発行元の会社名', 200, '例：小島醸造株式会社'],
  ['postal_code', '発行元の郵便番号', 20, '例：484-0000'],
  ['address', '発行元の住所', 1000, '例：愛知県犬山市○○町1-2-3'],
  ['tel', '発行元の電話番号', 50, '例：0568-00-0000'],
  ['fax', '発行元のFAX番号', 50, '例：0568-00-0001'],
  ['email', '発行元のメールアドレス', 254, '例：info@example.jp'],
  ['contact_person', '発行元の担当者', 100, '例：小島 太郎'],
  ['invoice_reg_no', '適格請求書発行事業者登録番号', 14, '例：T1234567890123'],
  ['bank_name', '振込先の銀行名', 100, '例：○○銀行'],
  ['bank_branch_name', '振込先の支店名', 100, '例：犬山支店'],
  ['bank_account_number', '振込先の口座番号', 7, '例：0123456'],
  ['bank_account_holder', '振込先の口座名義', 200, '例：コジマジョウゾウ（カ'],
] as const;
export const presentationWarning = '数量・単価・送料・税率・合計は注文データから計算されるため、この画面では変更できません。金額を修正する場合は、請求を取り消し、元の注文を修正してから再発行してください。';

export function invoicePresentation(snapshot: Row): InvoicePresentation {
  const issuer = Object.fromEntries([...issuerFields.map(([key]) => [key, String(snapshot.issuer?.[key] ?? '')]), ['bank_account_type', String(snapshot.issuer?.bank_account_type ?? '')]]);
  return {
    title: snapshot.report_settings?.invoice_title || '御請求書', recipient_name: snapshot.company?.name ?? '', recipient_address: snapshot.company?.address ?? '',
    due_date: snapshot.invoice?.due_date || null, note: snapshot.invoice?.note ?? snapshot.report_settings?.invoice_note_template ?? '', issuer,
  };
}
export function applyInvoicePresentation(snapshot: Row, changes: InvoicePresentation): Row {
  return {
    ...snapshot, company: { ...snapshot.company, name: changes.recipient_name, address: changes.recipient_address },
    report_settings: { ...snapshot.report_settings, invoice_title: changes.title },
    invoice: { ...snapshot.invoice, due_date: changes.due_date, note: changes.note },
    issuer: { ...snapshot.issuer, ...changes.issuer },
  };
}

export function InvoicePresentationEditor({ value, onChange, onPreview, onCancel, onSave, previewed, busy, locked, unchanged, conflict = false }: {
  value: InvoicePresentation; onChange: (value: InvoicePresentation) => void; onPreview: () => void; onCancel: () => void;
  onSave: () => void; previewed: boolean; busy: boolean; locked: boolean; unchanged: boolean; conflict?: boolean;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); onPreview(); };
  return <section className="report-editor" aria-label="請求書の表示内容を編集">
    <h2>請求書の表示内容を編集</h2>
    <p>帳票の宛名・支払期日・備考・発行元・振込先を修正します。会社設定や他の帳票には反映されません。</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy || locked} className="report-edit-fields">
        <div className="report-edit-grid">
          <label>帳票タイトル<input value={value.title} required maxLength={100} placeholder="例：御請求書" onChange={event => onChange({ ...value, title: event.target.value })} /></label>
          <label>宛名<input value={value.recipient_name} required maxLength={200} placeholder="例：株式会社 小島酒店" onChange={event => onChange({ ...value, recipient_name: event.target.value })} /></label>
          <label className="report-edit-wide">宛先住所<textarea value={value.recipient_address} maxLength={1000} rows={2} placeholder="例：愛知県犬山市○○町1-2-3" onChange={event => onChange({ ...value, recipient_address: event.target.value })} /></label>
          <label>支払期日<input type="date" value={value.due_date || ''} onChange={event => onChange({ ...value, due_date: event.target.value || null })} /></label>
          <label className="report-edit-wide">備考<textarea value={value.note} maxLength={4000} rows={3} placeholder="例：振込手数料は貴社にてご負担ください。" onChange={event => onChange({ ...value, note: event.target.value })} /></label>
        </div>
        <details className="report-issuer-editor"><summary>発行元・振込先を編集</summary><p>口座・登録番号を修正する場合は、発行前に正しい内容を確認してください。</p><div className="report-edit-grid">
          {issuerFields.map(([key, label, length, example]) => <label key={key} className={key === 'address' ? 'report-edit-wide' : undefined}>{label}<input
            type={key === 'email' ? 'email' : 'text'} value={value.issuer[key]} maxLength={length} placeholder={example}
            pattern={key === 'invoice_reg_no' ? 'T[0-9]{13}' : key === 'bank_account_number' ? '[0-9]{6,7}' : undefined}
            onChange={event => onChange({ ...value, issuer: { ...value.issuer, [key]: event.target.value } })}
          /></label>)}
          <label>振込先の口座種別<select value={value.issuer.bank_account_type} onChange={event => onChange({ ...value, issuer: { ...value.issuer, bank_account_type: event.target.value } })}><option value="">未指定</option><option value="普通">普通</option><option value="当座">当座</option></select></label>
        </div></details>
      </fieldset>
      {locked && <p className="report-edit-note" role="status">{conflict ? '別の操作で更新されています。最新の内容を読み直してから編集をやり直してください。' : '保存結果を確認できませんでした。同じ内容・送信番号で再試行できます。最新の版を読み直してから編集をやり直すこともできます。'}</p>}
      <div className="report-edit-actions">
        <button type="button" disabled={busy} onClick={onCancel}><RotateCcw size={17} />編集を閉じる</button>
        {!locked && <button type="submit" disabled={busy || unchanged}><Eye size={17} />編集内容をプレビュー</button>}
        {previewed && <button type="button" className="report-primary" disabled={busy} onClick={onSave}><Save size={17} />新しい版として保存</button>}
      </div>
    </form>
  </section>;
}
