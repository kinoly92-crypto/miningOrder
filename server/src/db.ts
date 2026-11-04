import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectType } from '../../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ORDER_RECORD_DATA_DIR
  ? path.resolve(process.env.ORDER_RECORD_DATA_DIR)
  : path.resolve(here, '../data');
fs.mkdirSync(dataDir, { recursive: true });

/** 单文件数据库：全部数据都在 server/data/app.db 里 */
export const db = new DatabaseSync(path.join(dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* ------------------------------------------------------------------ *
 * 表结构
 * 关键点：防重复派单不靠人自觉，而是由数据库约束直接锁死
 *   - projects.project_code         唯一索引：派单单号全局唯一
 *   - dispatches(project_id, dept_id) 联合唯一：同一项目同一平台只能有一条有效派单，
 *     但允许同一项目由多个平台协作承接
 * ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('director', 'viewer')),
  dept_id            INTEGER REFERENCES departments(id),
  created_at         TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS admin_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_code  TEXT NOT NULL UNIQUE,
  project_name  TEXT NOT NULL,
  client_name   TEXT,
  client_contact TEXT,
  client_phone   TEXT,
  business_source TEXT,
  business_level  TEXT,
  project_type  TEXT NOT NULL,
  eval_purpose  TEXT,
  estimated_fee REAL,
  deadline      TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dept_id       INTEGER NOT NULL REFERENCES departments(id),
  assignee      TEXT NOT NULL,
  dispatcher_id INTEGER NOT NULL REFERENCES users(id),
  dispatched_at TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'dispatched'
                CHECK (status IN ('dispatched', 'done', 'terminated')),
  remark        TEXT,
  actual_completion_date TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  user_name   TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

/*
 * 防重复派单的硬约束（部分唯一索引）：
 * 同一项目 + 同一平台，只允许存在一条"未被撤销"的派单记录。
 * 撤销（status='terminated'）的记录仍保留在台账里可追溯，
 * 同时不会挡住该平台后续重新承接这个项目。
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_active_unique
  ON dispatches(project_id, dept_id) WHERE status <> 'terminated';

CREATE INDEX IF NOT EXISTS idx_dispatches_project ON dispatches(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
const projectColumns = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
if (!projectColumns.some((column) => column.name === 'pending_reset')) {
  db.exec('ALTER TABLE projects ADD COLUMN pending_reset INTEGER NOT NULL DEFAULT 0');
}
for (const name of ['client_contact', 'client_phone', 'business_source', 'business_level']) {
  if (!projectColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} TEXT`);
}
const dispatchColumns = db.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[];
for (const name of ['team_members', 'signatory_one', 'signatory_two', 'actual_completion_date']) {
  if (!dispatchColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE dispatches ADD COLUMN ${name} TEXT`);
}
// 合并「执行中」到「已派单」
db.exec("UPDATE dispatches SET status = 'dispatched' WHERE status = 'in_progress'");
if (!userColumns.some((column) => column.name === 'is_active')) {
  db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
}
if (!userColumns.some((column) => column.name === 'auth_version')) {
  db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some((column) => column.name === 'must_change_password')) {
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

export function now(): string {
  return new Date().toISOString();
}

/** 用于"本月派单量"统计：本地时区当月 1 日 0 点的 ISO 字符串 */
export function monthStartIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).toISOString();
}

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, derived] = stored.split(':');
  if (!salt || !derived) return false;
  const candidate = crypto.scryptSync(plain, salt, 64);
  const expected = Buffer.from(derived, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export const PROJECT_TYPES: ProjectType[] = [
  '矿业权出让收益报告',
  '矿业权出让底价报告',
  '矿业权评估报告',
  '矿业权价款退还报告',
  '咨询报告',
  '其他',
];

const DISPATCH_NO_RE = /^PD(\d{4})--(\d{4})$/;

export function isValidProjectType(value: string | null | undefined): value is ProjectType {
  return Boolean(value) && PROJECT_TYPES.includes(value as ProjectType);
}

export function isValidDispatchNo(value: string | null | undefined): value is string {
  return typeof value === 'string' && DISPATCH_NO_RE.test(value);
}

export function generateDispatchNo(date = new Date()): string {
  const year = date.getFullYear();
  const prefix = `PD${year}--`;
  const rows = db
    .prepare('SELECT project_code FROM projects WHERE project_code LIKE ?')
    .all(`${prefix}%`) as { project_code: string }[];
  const maxSeq = rows.reduce((max, row) => {
    const match = DISPATCH_NO_RE.exec(row.project_code);
    if (!match || Number(match[1]) !== year) return max;
    return Math.max(max, Number(match[2]));
  }, 0);
  if (maxSeq >= 9999) throw new Error('DISPATCH_SEQUENCE_EXHAUSTED');
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
}

function isoDaysAgo(days: number, hour = 9, minute = 30): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/* ------------------------------------------------------------------ *
 * 种子数据（仅首次启动、平台表为空时写入）
 * ------------------------------------------------------------------ */

function initialPassword(): string {
  return process.env.ORDER_RECORD_INITIAL_PASSWORD ?? '123456';
}

function initialAdminPassword(): string {
  return process.env.ORDER_RECORD_INITIAL_ADMIN_PASSWORD ?? '4100282';
}

function seed(): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM departments').get() as { c: number };
  if (c > 0) return;

  const plainPassword = initialPassword();
  const adminPassword = initialAdminPassword();
  const deptId: Record<string, number> = {};
  const insertDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
  for (const name of ['中和西南分公司', '中和金乾', '云南俊成']) {
    deptId[name] = Number(insertDept.run(name).lastInsertRowid);
  }

  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAdmin = db.prepare('INSERT INTO admin_accounts (user_id) VALUES (?)');
  const ts = now();
  const userId: Record<string, number> = {};
  const seedUsers: [string, string, 'director' | 'admin', string | null][] = [
    ['licl', '李春林', 'director', '云南俊成'],
    ['cunq', '寸清', 'director', '云南俊成'],
    ['yinzx', '尹正祥', 'director', '云南俊成'],
    ['wangyj', '王玉娟', 'director', '云南俊成'],
    ['xiangs', '项尚', 'director', '云南俊成'],
    ['sysadmin', '系统管理员', 'admin', '云南俊成'],
  ];
  for (const [username, displayName, role, dept] of seedUsers) {
    const pwd = role === 'admin' ? adminPassword : plainPassword;
    const dbRole = role === 'admin' ? 'director' : role;
    userId[username] = Number(
      insertUser.run(username, hashPassword(pwd), displayName, dbRole, dept ? deptId[dept] : null, ts, 1).lastInsertRowid,
    );
    if (role === 'admin') {
      insertAdmin.run(userId[username]);
    }
  }

  const insertProject = db.prepare(
    `INSERT INTO projects
       (project_code, project_name, client_name, project_type, eval_purpose, estimated_fee, deadline, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDispatch = db.prepare(
    `INSERT INTO dispatches
       (project_id, dept_id, assignee, dispatcher_id, dispatched_at, status, remark, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  interface SeedDispatch {
    dept: string;
    assignee: string;
    dispatcher: string;
    status: 'dispatched' | 'done';
    daysAgo: number;
    remark: string;
  }
  const seedProjects: {
    code: string;
    name: string;
    client: string;
    type: ProjectType;
    purpose: string;
    fee: number;
    deadline: string;
    daysAgo: number;
    dispatches: SeedDispatch[];
  }[] = [
    {
      code: 'PD2026--0001',
      name: '华兴机械制造有限公司股东全部权益价值评估',
      client: '华兴机械制造有限公司',
      type: '矿业权评估报告',
      purpose: '股权交易',
      fee: 85000,
      deadline: '2026-11-30',
      daysAgo: 26,
      dispatches: [
        {
          dept: '中和西南分公司',
          assignee: '陈志强',
          dispatcher: 'licl',
          status: 'dispatched',
          daysAgo: 25,
          remark: '已与委托方约好下周一到场勘查',
        },
      ],
    },
    {
      code: 'PD2026--0002',
      name: '恒瑞物流园区土地使用权及地上建筑物价值评估',
      client: '恒瑞物流集团股份有限公司',
      type: '矿业权出让底价报告',
      purpose: '抵押融资',
      fee: 62000,
      deadline: '2026-11-20',
      daysAgo: 19,
      dispatches: [
        {
          dept: '中和金乾',
          assignee: '刘雅琴',
          dispatcher: 'yinzx',
          status: 'dispatched',
          daysAgo: 18,
          remark: '现场勘查已完成，正在测算',
        },
      ],
    },
    {
      code: 'PD2026--0003',
      name: '云岭矿业有限公司铜矿采矿权评估',
      client: '云岭矿业有限公司',
      type: '矿业权评估报告',
      purpose: '出让收益评估',
      fee: 180000,
      deadline: '2026-12-15',
      daysAgo: 14,
      dispatches: [
        {
          dept: '云南俊成',
          assignee: '赵宏博',
          dispatcher: 'cunq',
          status: 'dispatched',
          daysAgo: 13,
          remark: '需协调地质资料调阅',
        },
      ],
    },
    {
      code: 'PD2026--0004',
      name: '明德食品有限公司清算整体资产处置评估',
      client: '明德食品有限公司',
      type: '矿业权价款退还报告',
      purpose: '破产清算',
      fee: 45000,
      deadline: '2026-11-10',
      daysAgo: 11,
      dispatches: [
        {
          dept: '中和西南分公司',
          assignee: '孙立平',
          dispatcher: 'licl',
          status: 'done',
          daysAgo: 10,
          remark: '报告已提交委托方',
        },
        {
          dept: '中和金乾',
          assignee: '周敏',
          dispatcher: 'yinzx',
          status: 'dispatched',
          daysAgo: 8,
          remark: '负责存货盘点部分，两平台协作项目',
        },
      ],
    },
    {
      code: 'PD2026--0005',
      name: '金沙河砂石矿采矿权出让收益评估',
      client: '金源建材有限公司',
      type: '矿业权出让收益报告',
      purpose: '出让收益评估',
      fee: 210000,
      deadline: '2026-12-31',
      daysAgo: 5,
      dispatches: [],
    },
    {
      code: 'PD2026--0006',
      name: '东方医院专利及商标无形资产评估',
      client: '东方医院管理有限公司',
      type: '咨询报告',
      purpose: '资产收购',
      fee: 38000,
      deadline: '2026-11-25',
      daysAgo: 3,
      dispatches: [],
    },
    {
      code: 'PD2026--0007',
      name: '瑞丰纺织设备生产线整体资产评估',
      client: '瑞丰纺织实业有限公司',
      type: '其他',
      purpose: '资产收购',
      fee: 52000,
      deadline: '2026-12-05',
      daysAgo: 2,
      dispatches: [],
    },
  ];

  for (const p of seedProjects) {
    const created = isoDaysAgo(p.daysAgo);
    const projectId = Number(
      insertProject.run(
        p.code,
        p.name,
        p.client,
        p.type,
        p.purpose,
        p.fee,
        p.deadline,
        userId[p.dispatches[0]?.dispatcher ?? 'licl'],
        created,
        created,
      ).lastInsertRowid,
    );
    for (const d of p.dispatches) {
      const at = isoDaysAgo(d.daysAgo);
      insertDispatch.run(
        projectId,
        deptId[d.dept],
        d.assignee,
        userId[d.dispatcher],
        at,
        d.status,
        d.remark,
        at,
      );
    }
  }

  console.log('[db] 已初始化演示数据：3 个平台、6 个账号、7 个评估项目');
}

seed();
