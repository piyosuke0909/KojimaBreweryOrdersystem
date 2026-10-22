export type OrderStatus = 'received' | 'shipped' | 'cancelled';

/** Preserve historical rows while presenting the current three-state workflow. */
export function normalizeOrderStatus(status: string): string {
  if (status === 'confirmed' || status === 'preparing') return 'received';
  if (status === 'completed') return 'shipped';
  return status;
}

export function orderStatusValues(status: string): readonly string[] {
  switch (normalizeOrderStatus(status)) {
    case 'received': return ['received', 'confirmed', 'preparing'];
    case 'shipped': return ['shipped', 'completed'];
    default: return [status];
  }
}
