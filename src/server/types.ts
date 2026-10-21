export interface Actor { id: string; type: 'admin'|'customer'; company_id?: string; name: string; role?: string; company_name?: string; staff_name?: string }
export interface Bindings {
  DB: D1Database; ASSETS: Fetcher;
  APP_ENV?: string; ALLOW_DEMO_AUTH?: string; SESSION_SECRET?: string;
  INVITATION_TOKEN_ENCRYPTION_KEY?: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string; LINE_CHANNEL_ID?: string; LIFF_ID?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string; LINE_CHANNEL_SECRET?: string; LINE_MESSAGING_CHANNEL_ID?: string;
  NOTIFICATION_EMAIL_API_KEY?: string; NOTIFICATION_FROM?: string;
}
export type AppEnv = { Bindings: Bindings; Variables: { actor: Actor } };
export default AppEnv;
