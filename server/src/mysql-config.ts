import fs from 'node:fs';
import type { PoolOptions } from 'mysql2/promise';

export function mysqlConfig(): PoolOptions {
  const { MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) {
    throw new Error('启用 MySQL 时必须配置 MYSQL_HOST、MYSQL_USER、MYSQL_PASSWORD 和 MYSQL_DATABASE');
  }
  const port = Number(process.env.MYSQL_PORT ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_PORT 不合法');
  const ssl = process.env.MYSQL_TLS === 'true'
    ? { rejectUnauthorized: true, ...(process.env.MYSQL_CA_FILE ? { ca: fs.readFileSync(process.env.MYSQL_CA_FILE, 'utf8') } : {}) }
    : undefined;
  return {
    host: MYSQL_HOST,
    port,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    ssl,
  };
}
