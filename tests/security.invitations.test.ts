import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { issueInvitation, registerInvitation } from '../src/server/services/invitations';

/**
 * Executes the production D1 service's SQL, including the rollback boundary, in SQLite.
 * LINE identity here is an already verified service input; HTTP token verification is
 * separately exercised by line-customer-auth.test.ts and real LINE login remains external.
 */
class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  binding() { return this as unknown as D1Database; }
}
class Statement {
  constructor(private db: SqliteD1, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args), success: true }; }
  execute() {
    const result = this.db.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

let db: SqliteD1;
const owner = { id: 'test-admin', type: 'admin', role: 'owner', name: '検証管理者' };
beforeEach(() => {
  db = new SqliteD1();
  db.sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.sqlite.exec(`
    INSERT INTO admins(id,login_id,password_hash,name) VALUES('test-admin','test-admin','unused','検証管理者');
    INSERT INTO companies(id,name) VALUES('a','A酒店'),('b','Bホテル');
    INSERT INTO settings(key,value) VALUES('invite_default_max_uses','5'),('invite_valid_days','30');
  `);
});
afterEach(() => db.sqlite.close());

const issue = (company = 'a', input: Record<string, any> = {}) => issueInvitation(db.binding(), owner, company, input, 'https://orders.example');
const count = (table: string) => Number((db.sqlite.prepare(`SELECT count(*) count FROM ${table}`).get() as any).count);
const invitationRow = (id: string): any => db.sqlite.prepare('SELECT * FROM invitations WHERE id=?').get(id);

describe('invitation integrity with production SQL and SQLite transactions', () => {
  test('stores only a token hash and uses five registrations by default', async () => {
    const invitation = await issue();
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invitation.max_uses).toBe(5);
    const stored = invitationRow(invitation.id);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(invitation.token);
    expect(JSON.stringify(stored)).not.toContain(invitation.token);
    const logs = db.sqlite.prepare('SELECT * FROM audit_logs').all();
    expect(JSON.stringify(logs)).not.toContain(invitation.token);
    expect(invitation.url).toBe(`https://orders.example/invite?t=${invitation.token}`);
    expect((await issue('a', { max_uses: null })).max_uses).toBeNull();
  });

  test('never exceeds max_uses when different staff register concurrently', async () => {
    const invitation = await issue('a', { max_uses: 3 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      registerInvitation(db.binding(), { sub: `line-${index}`, name: `LINE ${index}` }, invitation.token, `担当 ${index}`),
    ));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(invitationRow(invitation.id).used_count).toBe(3);
    expect(count('line_users')).toBe(3);
    expect(count('audit_logs')).toBe(4); // Invitation issuance plus three registrations.
  });

  test('same-company rereads remain idempotent even after the invitation is full', async () => {
    const invitation = await issue('a', { max_uses: 1 });
    const first = await registerInvitation(db.binding(), { sub: 'repeat' }, invitation.token, '同じ担当者');
    const repeated = await registerInvitation(db.binding(), { sub: 'repeat' }, invitation.token, '同じ担当者');
    expect(repeated.id).toBe(first.id);
    expect(invitationRow(invitation.id).used_count).toBe(1);
    expect(count('line_users')).toBe(1);
    expect(count('audit_logs')).toBe(2);
  });

  test('concurrent retries for the same LINE account consume one slot and return the same registration', async () => {
    const invitation = await issue('a', { max_uses: 1 });
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      registerInvitation(db.binding(), { sub: 'same-line-account', name: '同じLINE本人' }, invitation.token, '同じ担当者'),
    ));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results.every(result => result.company_id === 'a')).toBe(true);
    expect(invitationRow(invitation.id).used_count).toBe(1);
    expect(count('line_users')).toBe(1);
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action='LINE_USER_REGISTER'").get()).toMatchObject({ count: 1 });
    expect(db.sqlite.prepare('SELECT line_user_id,company_id FROM line_users').all()).toEqual([{ line_user_id: 'same-line-account', company_id: 'a' }]);
  });

  test('concurrent invitations for different companies cannot rebind the same LINE account or consume the losing company slot', async () => {
    const a = await issue('a', { max_uses: 1 });
    const b = await issue('b', { max_uses: 1 });
    const results = await Promise.allSettled([a, b].map(invitation =>
      registerInvitation(db.binding(), { sub: 'one-account-two-companies' }, invitation.token, '同じLINE担当者'),
    ));
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const company = fulfilled[0].value.company_id;
    const winner = company === 'a' ? a : b;
    const loser = company === 'a' ? b : a;
    expect(invitationRow(winner.id).used_count).toBe(1);
    expect(invitationRow(loser.id).used_count).toBe(0);
    expect(count('line_users')).toBe(1);
    expect(db.sqlite.prepare('SELECT id,line_user_id,company_id FROM line_users').get()).toMatchObject({ id: fulfilled[0].value.id, line_user_id: 'one-account-two-companies', company_id: company });
    expect(db.sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action='LINE_USER_REGISTER'").get()).toMatchObject({ count: 1 });
    expect(count('audit_logs')).toBe(3); // Two invitations and only the winning registration.
  });

  test('prevents active cross-company rebinding and permits it only after admin unlink', async () => {
    const a = await issue('a');
    const b = await issue('b');
    const first = await registerInvitation(db.binding(), { sub: 'rebind' }, a.token, '担当者');
    await expect(registerInvitation(db.binding(), { sub: 'rebind' }, b.token, '担当者')).rejects.toMatchObject({ status: 409 });
    expect(invitationRow(b.id).used_count).toBe(0);
    db.sqlite.prepare("UPDATE line_users SET status='unlinked' WHERE id=?").run(first.id);
    const rebound = await registerInvitation(db.binding(), { sub: 'rebind' }, b.token, '新しい担当者');
    expect(rebound.id).toBe(first.id);
    expect(rebound.company_id).toBe('b');
    expect(invitationRow(b.id).used_count).toBe(1);
  });

  test('rejects revoked and expired invitations without consuming a slot', async () => {
    const invitation = await issue('a');
    db.sqlite.prepare("UPDATE invitations SET status='revoked' WHERE id=?").run(invitation.id);
    await expect(registerInvitation(db.binding(), { sub: 'revoked' }, invitation.token, '担当者')).rejects.toMatchObject({ status: 410 });
    db.sqlite.prepare("UPDATE invitations SET status='active',expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(invitation.id);
    await expect(registerInvitation(db.binding(), { sub: 'expired' }, invitation.token, '担当者')).rejects.toMatchObject({ status: 410 });
    expect(invitationRow(invitation.id).used_count).toBe(0);
    expect(count('line_users')).toBe(0);
  });

  test('rolls back slot consumption and user creation when the audit insert fails', async () => {
    const invitation = await issue('a');
    db.sqlite.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='LINE_USER_REGISTER' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END;");
    await expect(registerInvitation(db.binding(), { sub: 'audit-failure' }, invitation.token, '担当者')).rejects.toThrow();
    expect(invitationRow(invitation.id).used_count).toBe(0);
    expect(count('line_users')).toBe(0);
    expect(count('audit_logs')).toBe(1);
  });
});
