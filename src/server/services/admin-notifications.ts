import { fail, now, one, rows, uid, type Row } from './common';

type Kind='order_created'|'order_updated'|'order_cancelled'|'line_message';
type Event={event_key:string;kind:Kind;company_id:string;order_id?:string|null;line_user_id?:string|null;title:string;created_at?:string};

/** Include in the business transaction; a replay of the same event stays one notification. */
export function adminNotificationStatement(db:D1Database,event:Event):D1PreparedStatement {
  const category=event.kind==='line_message'?'companies':'orders';
  return db.prepare(`INSERT INTO admin_notifications(id,event_key,kind,category,company_id,order_id,line_user_id,title,created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).bind(uid(),event.event_key,event.kind,category,event.company_id,event.order_id??null,event.line_user_id??null,event.title.slice(0,300),event.created_at??now());
}

/** line_user_id is the internal line_users.id, never the provider's raw identifier. */
export function lineMessageNotificationStatement(db:D1Database,event:{event_key:string;company_id:string;line_user_id:string;company_name:string;staff_name?:string;created_at?:string;persisted_message_id?:string}):D1PreparedStatement {
  const title=`${event.company_name}${event.staff_name?`・${event.staff_name}`:''}からLINEメッセージ`;
  if(event.persisted_message_id)return db.prepare(`INSERT INTO admin_notifications(id,event_key,kind,category,company_id,order_id,line_user_id,title,created_at)
    SELECT ?,?,'line_message','companies',?,NULL,?,?,? WHERE EXISTS(
      SELECT 1 FROM line_messages WHERE id=? AND company_id=? AND line_user_id=? AND direction='incoming' AND message_type!='unsent')
    ON CONFLICT(event_key) DO NOTHING`).bind(uid(),event.event_key,event.company_id,event.line_user_id,title.slice(0,300),event.created_at??now(),event.persisted_message_id,event.company_id,event.line_user_id);
  return adminNotificationStatement(db,{...event,kind:'line_message',title});
}

export function orderNotificationStatement(db:D1Database,order:Row,kind:'create'|'edit'|'cancel'):D1PreparedStatement {
  const label={create:'新しい注文',edit:'注文内容の変更',cancel:'注文のキャンセル'}[kind];
  const type={create:'order_created',edit:'order_updated',cancel:'order_cancelled'} as const;
  return adminNotificationStatement(db,{event_key:`order:${kind}:${order.id}:v${order.version}`,kind:type[kind],company_id:order.company_id,order_id:order.id,title:`${order.company_name||'お取引先'}：${label} ${order.id}`,created_at:kind==='create'?order.ordered_at:order.updated_at});
}

function publicEvent(row:Row){
  const href=row.category==='orders'?`/admin/orders/${encodeURIComponent(row.order_id)}`:`/admin/companies/${encodeURIComponent(row.company_id)}?tab=line-messages&line_user_id=${encodeURIComponent(row.line_user_id)}`;
  return {id:row.id,kind:row.kind,category:row.category,title:row.title,company_id:row.company_id,order_id:row.order_id,line_user_id:row.line_user_id,href,created_at:row.created_at,is_read:!!row.is_read};
}

export async function listAdminNotifications(db:D1Database,adminId:string){
  const [events,counts]=await Promise.all([
    rows(db,`SELECT n.*,CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS is_read
      FROM admin_notifications n LEFT JOIN admin_notification_reads r ON r.notification_id=n.id AND r.admin_id=?
      ORDER BY n.created_at DESC,n.rowid DESC LIMIT 5`,adminId),
    one(db,`SELECT COUNT(*) AS total_unread,
      COALESCE(SUM(CASE WHEN n.category='orders' THEN 1 ELSE 0 END),0) AS orders,
      COALESCE(SUM(CASE WHEN n.category='companies' THEN 1 ELSE 0 END),0) AS companies
      FROM admin_notifications n WHERE NOT EXISTS(SELECT 1 FROM admin_notification_reads r WHERE r.notification_id=n.id AND r.admin_id=?)`,adminId),
  ]);
  return {items:events.map(publicEvent),total_unread:Number(counts?.total_unread||0),counts:{orders:Number(counts?.orders||0),companies:Number(counts?.companies||0)}};
}

export async function readAdminNotification(db:D1Database,adminId:string,id:string){
  if(!await one(db,'SELECT id FROM admin_notifications WHERE id=?',id))fail(404,'NOT_FOUND','通知が見つかりません。');
  await db.prepare(`INSERT INTO admin_notification_reads(notification_id,admin_id,read_at) VALUES(?,?,?)
    ON CONFLICT(notification_id,admin_id) DO NOTHING`).bind(id,adminId,now()).run();
}

export async function readAllAdminNotifications(db:D1Database,adminId:string){
  await db.prepare(`INSERT INTO admin_notification_reads(notification_id,admin_id,read_at)
    SELECT id,?,? FROM admin_notifications WHERE 1=1 ON CONFLICT(notification_id,admin_id) DO NOTHING`).bind(adminId,now()).run();
}

export async function readLineConversationNotifications(db:D1Database,adminId:string,companyId:string,lineUserId:string,eventKeys?:readonly string[]){
  if(eventKeys && !eventKeys.length)return;
  await db.prepare(`INSERT INTO admin_notification_reads(notification_id,admin_id,read_at)
    SELECT id,?,? FROM admin_notifications WHERE kind='line_message' AND company_id=? AND line_user_id=?
    ${eventKeys?'AND event_key IN (SELECT value FROM json_each(?))':''}
    ON CONFLICT(notification_id,admin_id) DO NOTHING`).bind(adminId,now(),companyId,lineUserId,...(eventKeys?[JSON.stringify(eventKeys)]:[])).run();
}
