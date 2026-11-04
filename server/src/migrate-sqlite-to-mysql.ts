import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { mysqlConfig } from './mysql-config';
import { MYSQL_SCHEMA } from './mysql-schema';

const tables = [
  { name: 'departments', columns: ['id', 'name'] },
  { name: 'users', columns: ['id', 'username', 'password_hash', 'display_name', 'role', 'dept_id', 'created_at', 'is_active', 'auth_version'] },
  { name: 'admin_accounts', columns: ['user_id'] },
  { name: 'projects', columns: ['id', 'project_code', 'project_name', 'client_name', 'client_contact', 'client_phone', 'business_source', 'business_level', 'project_type', 'eval_purpose', 'estimated_fee', 'deadline', 'created_by', 'created_at', 'updated_at', 'pending_reset'] },
  { name: 'dispatches', columns: ['id', 'project_id', 'dept_id', 'assignee', 'team_members', 'signatory_one', 'signatory_two', 'dispatcher_id', 'dispatched_at', 'status', 'remark', 'actual_completion_date', 'updated_at'] },
  { name: 'audit_logs', columns: ['id', 'user_id', 'user_name', 'action', 'target_type', 'target_id', 'detail', 'created_at'] },
] as const;

async function main(): Promise<void> {
  const source = process.env.SQLITE_SOURCE;
  const database = process.env.MYSQL_DATABASE;
  if (!process.argv.includes('--apply') || !database || process.env.MYSQL_MIGRATION_CONFIRM !== database) {
    throw new Error('迁移未执行：请先设置 MYSQL_DATABASE、MYSQL_MIGRATION_CONFIRM（与数据库名称一致）和 SQLITE_SOURCE，再显式传入 --apply');
  }
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) {
    throw new Error('SQLITE_SOURCE 必须是现有 SQLite 数据库文件的绝对路径');
  }

  const sqlite = new DatabaseSync(source, { readOnly: true });
  let connection: Connection | undefined;
  let targetTransaction = false;
  try {
    connection = await mysql.createConnection(mysqlConfig());
    sqlite.exec('BEGIN');
    const foreignKeys = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error('SQLite 存在外键异常，未开始迁移');
    const projectColumns = sqlite.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    const dispatchColumns = sqlite.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[];
    const optionalColumns = new Set(['pending_reset', 'client_contact', 'client_phone', 'business_source', 'business_level', 'team_members', 'signatory_one', 'signatory_two', 'actual_completion_date']);
    const sourceRows = tables.map(({ name, columns }) => ({
      name,
      columns,
      rows: sqlite.prepare(`SELECT ${columns.map((column) => {
        const sourceColumns = name === 'projects' ? projectColumns : name === 'dispatches' ? dispatchColumns : undefined;
        if (sourceColumns && optionalColumns.has(column) && !sourceColumns.some((c) => c.name === column)) {
          return `${column === 'pending_reset' ? '0' : 'NULL'} AS ${column}`;
        }
        return column;
      }).join(', ')} FROM ${name} ORDER BY ${columns[0]}`).all(),
    }));
    const [existing] = await connection.query<RowDataPacket[]>(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    );
    if (existing.length) throw new Error('目标 MySQL 数据库不是空库，迁移已停止；不会覆盖已有表');

    for (const statement of MYSQL_SCHEMA) await connection.query(statement);
    await connection.beginTransaction();
    targetTransaction = true;
    await connection.query('INSERT INTO app_locks (id) VALUES (1)');
    for (const { name, columns, rows } of sourceRows) {
      const sql = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      for (const row of rows) {
        await connection.query(sql, columns.map((column) => row[column]));
      }
      const [count] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${name}`);
      if (Number(count[0].count) !== rows.length) throw new Error(`${name} 迁移行数不匹配`);
      console.log(`${name}: ${rows.length} 条`);
    }
    await connection.query('INSERT INTO app_schema (id, version) VALUES (1, 1)');
    await connection.commit();
    targetTransaction = false;
    sqlite.exec('COMMIT');
    console.log('数据已导入。请核对业务数据并验证后再切换应用。');
  } catch (error) {
    if (targetTransaction && connection) await connection.rollback().catch(() => undefined);
    try { sqlite.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
    throw error;
  } finally {
    sqlite.close();
    if (connection) await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error('迁移失败：', error instanceof Error ? error.message : error);
  console.error('MySQL 建表是非事务操作；如已创建空表，请先检查，勿覆盖现有数据。');
  process.exitCode = 1;
});
