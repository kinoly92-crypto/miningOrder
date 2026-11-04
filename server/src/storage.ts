import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { mysqlConfig } from './mysql-config';

type Param = string | number | null;
type Context = { kind: 'sqlite'; db: DatabaseSync } | { kind: 'mysql'; connection: PoolConnection };

const engine = process.env.DB_CLIENT ?? 'sqlite';
if (engine !== 'sqlite' && engine !== 'mysql') {
  throw new Error('DB_CLIENT 必须是 sqlite 或 mysql');
}

const context = new AsyncLocalStorage<Context>();
let sqlitePromise: Promise<DatabaseSync> | undefined;
let pool: Pool | undefined;
let sqliteQueue = Promise.resolve();

async function sqliteDatabase(): Promise<DatabaseSync> {
  sqlitePromise ??= import('./db').then((module) => module.db);
  return sqlitePromise;
}

function mysqlPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({ ...mysqlConfig(), connectionLimit: 10 });
  }
  return pool;
}

async function serializeSqlite<T>(fn: () => Promise<T>): Promise<T> {
  const previous = sqliteQueue;
  let release!: () => void;
  sqliteQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function all<T>(sql: string, params: Param[] = []): Promise<T[]> {
  const active = context.getStore();
  if (active?.kind === 'sqlite') return active.db.prepare(sql).all(...params as SQLInputValue[]) as T[];
  if (active?.kind === 'mysql') return (await active.connection.query<RowDataPacket[]>(sql, params))[0] as T[];
  if (engine === 'mysql') return (await mysqlPool().query<RowDataPacket[]>(sql, params))[0] as T[];
  return serializeSqlite(async () => (await sqliteDatabase()).prepare(sql).all(...params as SQLInputValue[]) as T[]);
}

export async function one<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
  return (await all<T>(sql, params))[0];
}

export async function execute(sql: string, params: Param[] = []): Promise<{ insertId: number; affectedRows: number }> {
  const active = context.getStore();
  if (active?.kind === 'sqlite') {
    const result = active.db.prepare(sql).run(...params as SQLInputValue[]);
    return { insertId: Number(result.lastInsertRowid), affectedRows: Number(result.changes) };
  }
  if (active?.kind === 'mysql' || engine === 'mysql') {
    const executor = active?.kind === 'mysql' ? active.connection : mysqlPool();
    const [result] = await executor.query<ResultSetHeader>(sql, params);
    return { insertId: result.insertId, affectedRows: result.affectedRows };
  }
  return serializeSqlite(async () => {
    const result = (await sqliteDatabase()).prepare(sql).run(...params as SQLInputValue[]);
    return { insertId: Number(result.lastInsertRowid), affectedRows: Number(result.changes) };
  });
}

export async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (context.getStore()) throw new Error('不支持嵌套数据库事务');
  if (engine === 'mysql') {
    const connection = await mysqlPool().getConnection();
    try {
      await connection.beginTransaction();
      const result = await context.run({ kind: 'mysql', connection }, fn);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
  return serializeSqlite(async () => {
    const db = await sqliteDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await context.run({ kind: 'sqlite', db }, fn);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
      throw error;
    }
  });
}

export async function lockDispatchCreation(): Promise<void> {
  if (!context.getStore()) throw new Error('派单编号锁只能在事务中获取');
  if (engine === 'mysql') {
    const lock = await one<{ id: number }>('SELECT id FROM app_locks WHERE id = 1 FOR UPDATE');
    if (!lock) throw new Error('MySQL 派单锁缺失，请检查数据库初始化');
  }
}

export async function lockDispatch(id: number): Promise<void> {
  if (!context.getStore()) throw new Error('派单记录锁只能在事务中获取');
  if (engine === 'mysql') await one('SELECT id FROM dispatches WHERE id = ? FOR UPDATE', [id]);
}

export async function verifyStorage(): Promise<void> {
  if (engine === 'sqlite') {
    await sqliteDatabase();
    return;
  }
  const schema = await one<{ version: number }>('SELECT version FROM app_schema WHERE id = 1');
  if (schema?.version !== 1) throw new Error('MySQL 数据库尚未完成迁移或版本不匹配');
  const column = await one<{ count: number }>(
    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND COLUMN_NAME = 'pending_reset'",
  );
  if (!column?.count) throw new Error('MySQL 缺少 pending_reset 字段，请先审阅并执行数据库升级');
  const additional = await one<{ count: number }>(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
     AND ((TABLE_NAME = 'projects' AND COLUMN_NAME IN ('client_contact', 'client_phone', 'business_source', 'business_level'))
       OR (TABLE_NAME = 'dispatches' AND COLUMN_NAME IN ('team_members', 'signatory_one', 'signatory_two', 'actual_completion_date')))`,
  );
  if (Number(additional?.count) !== 8) throw new Error('MySQL 缺少联系人或派单成员/完成日期字段，请先审阅并执行数据库升级');
}

export async function closeStorage(): Promise<void> {
  if (pool) await pool.end();
}
