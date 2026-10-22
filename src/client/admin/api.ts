export async function apiRaw<T = any>(path: string, options: RequestInit = {}): Promise<{data:T;meta?:any}> {
  const response = await fetch(path, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `通信に失敗しました（${response.status}）`);
  return body;
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> { return (await apiRaw<T>(path, options)).data; }
export const money = (n: unknown) => new Intl.NumberFormat('ja-JP', {style:'currency',currency:'JPY',maximumFractionDigits:0}).format(Number(n || 0));
export const date = (value: unknown, time = false) => value ? new Intl.DateTimeFormat('ja-JP', { year:'numeric',month:'2-digit',day:'2-digit',...(time ? {hour:'2-digit',minute:'2-digit'} : {}),timeZone:'Asia/Tokyo' }).format(new Date(String(value))) : '—';
export const labels: Record<string,string> = {received:'受付済',confirmed:'受付済',preparing:'受付済',shipped:'発送済',completed:'発送済',cancelled:'キャンセル済',issued:'発行済',paid:'入金済',active:'有効',inactive:'無効',revoked:'無効化',expired:'期限切れ',unlinked:'解除済',on_sale:'販売中',suspended:'販売停止',unavailable:'注文不可'};
