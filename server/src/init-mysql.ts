import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { mysqlConfig } from './mysql-config';
import { MYSQL_SCHEMA } from './mysql-schema';

/** 与 db.ts 保持一致的密码哈希算法，避免 import db.ts 触发 SQLite 初始化。 */
function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/** 初始密码必须通过环境变量显式传入，不写入源码。 */
function requirePassword(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 6 || value.length > 128) {
    throw new Error(`必须设置 ${name}，长度为 6 至 128 位`);
  }
  return value;
}

const PLATFORMS = ['中和西南分公司', '中和金乾', '云南俊成'] as const;

/** 全部账号统一归属云南俊成。 */
const USERS: { username: string; displayName: string; role: 'director' | 'admin' }[] = [
  { username: 'licl', displayName: '李春林', role: 'director' },
  { username: 'cunq', displayName: '寸清', role: 'director' },
  { username: 'yinzx', displayName: '尹正祥', role: 'director' },
  { username: 'wangyj', displayName: '王玉娟', role: 'director' },
  { username: 'xiangs', displayName: '项尚', role: 'director' },
  { username: 'sysadmin', displayName: '系统管理员', role: 'admin' },
];

async function main(): Promise<void> {
  const database = process.env.MYSQL_DATABASE;
  if (!process.argv.includes('--apply') || !database || process.env.MYSQL_INIT_CONFIRM !== database) {
    throw new Error(
      '初始化未执行：请先设置 MYSQL_DATABASE、MYSQL_INIT_CONFIRM（与数据库名称一致），再显式传入 --apply',
    );
  }
  const plainPassword = requirePassword('ORDER_RECORD_INITIAL_PASSWORD');
  const adminPassword = requirePassword('ORDER_RECORD_INITIAL_ADMIN_PASSWORD');

  const connection = await mysql.createConnection(mysqlConfig());
  try {
    const [existing] = await connection.query<RowDataPacket[]>(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    );
    if (existing.length) {
      throw new Error('目标 MySQL 数据库不是空库，初始化已停止；不会覆盖已有表');
    }

    for (const statement of MYSQL_SCHEMA) await connection.query(statement);

    await connection.beginTransaction();
    try {
      await connection.query('INSERT INTO app_locks (id) VALUES (1)');
      await connection.query('INSERT INTO app_schema (id, version) VALUES (1, 1)');

      const platformId: Record<string, number> = {};
      for (const name of PLATFORMS) {
        const [result] = await connection.query<ResultSetHeader>(
          'INSERT INTO departments (name) VALUES (?)',
          [name],
        );
        platformId[name] = result.insertId;
      }

      const createdAt = new Date().toISOString();
      for (const user of USERS) {
        const password = user.role === 'admin' ? adminPassword : plainPassword;
        const dbRole = user.role === 'admin' ? 'director' : user.role;
        const [result] = await connection.query<ResultSetHeader>(
          `INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [user.username, hashPassword(password), user.displayName, dbRole, platformId['云南俊成'], createdAt],
        );
        if (user.role === 'admin') {
          await connection.query('INSERT INTO admin_accounts (user_id) VALUES (?)', [result.insertId]);
        }
      }

      await connection.commit();
      console.log(`初始化完成：${PLATFORMS.length} 个平台、${USERS.length} 个账号`);
      console.log('首次登录将强制修改密码。');
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error('初始化失败：', error instanceof Error ? error.message : error);
  console.error('MySQL 建表是非事务操作；如已创建空表，请先检查，勿覆盖现有数据。');
  process.exitCode = 1;
});
