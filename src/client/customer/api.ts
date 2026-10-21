import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export async function api<T = any>(path: string, options: RequestInit = {}, envelope = false): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...options.headers },
  });
  let body: any;
  try { body = await response.json(); } catch { throw new ApiError('NETWORK_ERROR', 'サーバーからの応答を確認できませんでした。時間をおいて再度お試しください。', response.status); }
  if (!response.ok || body.error) throw new ApiError(body.error?.code || 'REQUEST_FAILED', body.error?.message || '処理に失敗しました。再度お試しください。', response.status);
  return envelope ? body : body.data;
}

export function useResource<T>(path: string | null, envelope = false, scope = '') {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [version, setVersion] = useState(0);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const requestKey = JSON.stringify([path, envelope, scope]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError(null);
    api<T>(path, {}, envelope).then((result) => { if (active) { setData(result); setSettledKey(requestKey); } }).catch((err) => { if (active) { setError(err); setSettledKey(requestKey); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, version, envelope, scope, requestKey]);
  const current = !!path && settledKey === requestKey;
  return { data: current ? data : null, error: current ? error : null, loading: !!path && (loading || !current), reload };
}

export const money = (amount: unknown) => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(Number(amount || 0));
export const formatDate = (value?: string, withTime = false) => value ? new Date(value.length === 10 ? `${value}T12:00:00+09:00` : value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short' }) }) : '—';
export const statuses: Record<string, string> = { received: '受付済', confirmed: '確認済', preparing: '配送準備中', shipping: '配送準備中', shipped: '発送済', completed: '完了', cancelled: 'キャンセル済' };

export interface Product {
  id: string; name: string; product_name?: string; category?: string; volume_ml?: number; capacity_ml?: number; unit?: string;
  unit_price?: number | null; is_available?: boolean | number; status?: string; sales_status?: string; is_limited?: number; image_url?: string;
  short_description?: string; description?: string; commitment?: string; taste?: string; recommended_way?: string;
}
export interface Address { id: string; name?: string; address_name?: string; recipient_name?: string; postal_code?: string; prefecture?: string; city?: string; address_line1?: string; address_line2?: string; address?: string; phone?: string; is_default?: number; delivery_type?: string; }
export interface Quote {
  items: any[]; packages: any[]; items_subtotal: number; shipping_fee: number; tax_amount: number; total_amount: number;
  is_reference_tax?: boolean; shipping_address?: Address; delivery_dates?: string[];
  shipping_features?: { packing_enabled: boolean; yamato_sizes_enabled: boolean; yamato_rates_enabled: boolean };
  shipping_fee_source?: 'automatic' | 'fixed' | 'manual' | 'free';
  delivery_method?: 'own_delivery' | 'yamato';
  snap_shipping_method?: string; snap_carrier_name?: string;
}
export const productName = (product: Product | any) => product.name || product.product_name || '商品';
export const addressName = (address?: Address | null) => address?.name || address?.address_name || address?.recipient_name || '配送先';
export const addressText = (address?: Address | null) => address ? [address.prefecture, address.city, address.address_line1, address.address_line2].filter(Boolean).join('') || address.address || '' : '';
