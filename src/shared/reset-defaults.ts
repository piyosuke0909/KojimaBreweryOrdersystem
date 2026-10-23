/** Safe production defaults; parity with seeds/production.sql is verified by reset tests. */
export const resetSettings: Readonly<Record<string,string>> = {
  "cancel_business_days": "3",
  "cancel_cutoff_time": "17:00",
  "contact_email": "",
  "contact_hours": "",
  "contact_phone": "",
  "edit_lock_minutes": "10",
  "invite_default_max_uses": "5",
  "invite_valid_days": "30",
  "manual_shipping_fee": "",
  "min_lead_business_days": "4",
  "multi_parcel_discount_amount": "0",
  "multi_parcel_discount_enabled": "false",
  "notification_email": "",
  "packing_enabled": "true",
  "price_tax_type": "excl",
  "shipping_taxable": "true",
  "tax_calc_unit": "invoice",
  "tax_rate": "10",
  "tax_rounding": "floor",
  "yamato_rates_enabled": "true",
  "yamato_sizes_enabled": "true"
};
export const resetProducts = [
  {
    "id": "samurai-300",
    "name": "犬山忍冬酒：侍の酒",
    "category": "新酒・ガラス瓶",
    "volume_ml": 300,
    "standard_price": 2500,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 1,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "samurai-500",
    "name": "犬山忍冬酒：侍の酒",
    "category": "新酒・ガラス瓶",
    "volume_ml": 500,
    "standard_price": 4000,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 2,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "samurai-700",
    "name": "犬山忍冬酒：侍の酒",
    "category": "新酒・ガラス瓶",
    "volume_ml": 700,
    "standard_price": 5500,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 3,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "kunoichi-300",
    "name": "忍冬梅酒：くノ一の酒",
    "category": "新酒・ガラス瓶",
    "volume_ml": 300,
    "standard_price": 2900,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 4,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "kunoichi-500",
    "name": "忍冬梅酒：くノ一の酒",
    "category": "新酒・ガラス瓶",
    "volume_ml": 500,
    "standard_price": 4500,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 5,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "kunoichi-700",
    "name": "忍冬梅酒：くノ一の酒",
    "category": "新酒・ガラス瓶",
    "volume_ml": 700,
    "standard_price": 6200,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 6,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "shogun-500",
    "name": "犬山忍冬酒：将軍の酒",
    "category": "熟成酒・ガラス瓶",
    "volume_ml": 500,
    "standard_price": 6800,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 7,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "umehime-500",
    "name": "忍冬梅酒：梅姫の酒",
    "category": "熟成酒・ガラス瓶",
    "volume_ml": 500,
    "standard_price": 6800,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 8,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "nindou-1800",
    "name": "犬山忍冬酒",
    "category": "新酒・一升瓶",
    "volume_ml": 1800,
    "standard_price": 8800,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 9,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "umeshu-1800",
    "name": "忍冬梅酒",
    "category": "新酒・一升瓶",
    "volume_ml": 1800,
    "standard_price": 9800,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 10,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。"
  },
  {
    "id": "mini-80",
    "name": "ミニボトル各種",
    "category": "80ml瓶",
    "volume_ml": 80,
    "standard_price": null,
    "weight_kg": 0.001,
    "sales_status": "unavailable",
    "sort_order": 11,
    "note": "重量未確定: 0.001kgは初期化用の仮値です。瓶を含む実測重量を登録し、販売状態を確認してから販売を開始してください。 ミニボトルは価格も未設定です。"
  }
] as const;
export const resetCompanyInfo = {
  "id": 1,
  "company_name": "小島醸造",
  "display_name": "小島醸造",
  "note": "本番利用前に正式な住所・連絡先・銀行口座・適格請求書登録番号を登録してください。"
} as const;
