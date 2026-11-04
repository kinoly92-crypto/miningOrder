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
 *   - dispatches(project_id, dept_id) 联合唯一：同一项目同一部门只能有一条有效派单，
 *     但允许同一项目由多个部门协作承接
 * ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('director', 'viewer')),
  dept_id       INTEGER REFERENCES departments(id),
  created_at    TEXT NOT NULL
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
 * 同一项目 + 同一部门，只允许存在一条"未被撤销"的派单记录。
 * 撤销（status='terminated'）的记录仍保留在台账里可追溯，
 * 同时不会挡住该部门后续重新承接这个项目。
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
  '资产评估报告',
  '房地产估价报告（含租金）',
  '土地估价报告',
  '矿业权报告',
  '债权分析报告',
  '咨询报告',
  '预估报告（函）',
];

const DISPATCH_NO_RE = /^PD(\d{4})-(\d{4})$/;

export function isValidProjectType(value: string | null | undefined): value is ProjectType {
  return Boolean(value) && PROJECT_TYPES.includes(value as ProjectType);
}

export function isValidDispatchNo(value: string | null | undefined): value is string {
  return typeof value === 'string' && DISPATCH_NO_RE.test(value);
}

export function generateDispatchNo(date = new Date()): string {
  const year = date.getFullYear();
  const prefix = `PD${year}-`;
  const rows = db
    .prepare('SELECT project_code FROM projects WHERE project_code LIKE ?')
    .all(`${prefix}%`) as { project_code: string }[];
  const maxSeq = rows.reduce((max, row) => {
    const match = DISPATCH_NO_RE.exec(row.project_code);
    if (!match || Number(match[1]) !== year) return max;
    return Math.max(max, Number(match[2]));
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
}

function isoDaysAgo(days: number, hour = 9, minute = 30): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function migrateLegacyProjectData(): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const legacyTypeRows = db
      .prepare(`SELECT id, project_type FROM projects WHERE project_type IN ('矿业权评估', '其他评估业务')`)
      .all() as { id: number; project_type: string }[];
    for (const row of legacyTypeRows) {
      const nextType: ProjectType = row.project_type === '矿业权评估' ? '矿业权报告' : '咨询报告';
      db.prepare('UPDATE projects SET project_type = ? WHERE id = ?').run(nextType, row.id);
    }

    const legacyCodeRows = db
      .prepare(
        `SELECT id, created_at, project_code
         FROM projects
         WHERE project_code GLOB 'PG[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'
            OR project_code GLOB 'MK[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as { id: number; created_at: string; project_code: string }[];

    if (legacyCodeRows.length > 0) {
      const counters = new Map<number, number>();
      for (const row of legacyCodeRows) {
        const year = new Date(row.created_at).getFullYear();
        const next = (counters.get(year) ?? 0) + 1;
        counters.set(year, next);
        const dispatchNo = `PD${year}-${String(next).padStart(4, '0')}`;
        db.prepare('UPDATE projects SET project_code = ? WHERE id = ?').run(dispatchNo, row.id);
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateProjectTypeNames(): void {
  const renameMap: Record<string, ProjectType> = {
    '资产评估': '资产评估报告',
    '房地产估价': '房地产估价报告（含租金）',
    '房地产估价（含租金）': '房地产估价报告（含租金）',
    '土地估价': '土地估价报告',
    '债权分析': '债权分析报告',
    '咨询': '咨询报告',
    '预估': '预估报告（函）',
  };
  const rows = db.prepare('SELECT id, project_type FROM projects').all() as { id: number; project_type: string }[];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const next = renameMap[row.project_type];
      if (next) db.prepare('UPDATE projects SET project_type = ? WHERE id = ?').run(next, row.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 种子数据（仅首次启动、部门表为空时写入）
 * ------------------------------------------------------------------ */

function bootstrapPassword(name: string): string {
  const password = process.env[name];
  if (!password || password.length < 12 || password.length > 128) {
    throw new Error(`初始化账号前必须设置 ${name}，长度为 12 至 128 位`);
  }
  return password;
}

function seed(): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM departments').get() as { c: number };
  if (c > 0) return;

  const initialPassword = bootstrapPassword('ORDER_RECORD_INITIAL_PASSWORD');
  bootstrapPassword('ORDER_RECORD_INITIAL_ADMIN_PASSWORD');
  const deptId: Record<string, number> = {};
  const insertDept = db.prepare('INSERT INTO departments (name) VALUES (?)');
  for (const name of ['业务1部', '业务2部', '矿业权部']) {
    deptId[name] = Number(insertDept.run(name).lastInsertRowid);
  }

  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const pwd = hashPassword(initialPassword);
  const ts = now();
  const userId: Record<string, number> = {};
  const seedUsers: [string, string, string, 'director' | 'viewer'][] = [
    ['zhoulh', '周利华', '业务1部', 'director'],
    ['zhaoky', '赵柯燚', '业务2部', 'director'],
    ['cunq', '寸清', '矿业权部', 'director'],
    ['audit', '综合管理岗（只读）', '', 'viewer'],
  ];
  for (const [username, displayName, dept, role] of seedUsers) {
    userId[username] = Number(
      insertUser.run(username, pwd, displayName, role, dept ? deptId[dept] : null, ts).lastInsertRowid,
    );
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
      code: 'PD2026-0001',
      name: '华兴机械制造有限公司股东全部权益价值评估',
      client: '华兴机械制造有限公司',
      type: '资产评估报告',
      purpose: '股权转让',
      fee: 85000,
      deadline: '2026-11-30',
      daysAgo: 26,
      dispatches: [
        {
          dept: '业务1部',
          assignee: '陈志强',
          dispatcher: 'zhoulh',
          status: 'dispatched',
          daysAgo: 25,
          remark: '已与委托方约好下周一到场勘查',
        },
      ],
    },
    {
      code: 'PD2026-0002',
      name: '恒瑞物流园区土地使用权及地上建筑物价值评估',
      client: '恒瑞物流集团股份有限公司',
      type: '土地估价报告',
      purpose: '抵押贷款',
      fee: 62000,
      deadline: '2026-11-20',
      daysAgo: 19,
      dispatches: [
        {
          dept: '业务2部',
          assignee: '刘雅琴',
          dispatcher: 'zhaoky',
          status: 'dispatched',
          daysAgo: 18,
          remark: '现场勘查已完成，正在测算',
        },
      ],
    },
    {
      code: 'PD2026-0003',
      name: '云岭矿业有限公司铜矿采矿权评估',
      client: '云岭矿业有限公司',
      type: '矿业权报告',
      purpose: '采矿权出让',
      fee: 180000,
      deadline: '2026-12-15',
      daysAgo: 14,
      dispatches: [
        {
          dept: '矿业权部',
          assignee: '赵宏博',
          dispatcher: 'cunq',
          status: 'dispatched',
          daysAgo: 13,
          remark: '需协调地质资料调阅',
        },
      ],
    },
    {
      code: 'PD2026-0004',
      name: '明德食品有限公司清算整体资产处置评估',
      client: '明德食品有限公司',
      type: '资产评估报告',
      purpose: '企业清算',
      fee: 45000,
      deadline: '2026-11-10',
      daysAgo: 11,
      dispatches: [
        {
          dept: '业务1部',
          assignee: '孙立平',
          dispatcher: 'zhoulh',
          status: 'done',
          daysAgo: 10,
          remark: '报告已提交委托方',
        },
        {
          dept: '业务2部',
          assignee: '周敏',
          dispatcher: 'zhaoky',
          status: 'dispatched',
          daysAgo: 8,
          remark: '负责存货盘点部分，两部门协作项目',
        },
      ],
    },
    {
      code: 'PD2026-0005',
      name: '金沙河砂石矿采矿权出让收益评估',
      client: '金源建材有限公司',
      type: '矿业权报告',
      purpose: '采矿权出让',
      fee: 210000,
      deadline: '2026-12-31',
      daysAgo: 5,
      dispatches: [],
    },
    {
      code: 'PD2026-0006',
      name: '东方医院专利及商标无形资产评估',
      client: '东方医院管理有限公司',
      type: '咨询报告',
      purpose: '作价入股',
      fee: 38000,
      deadline: '2026-11-25',
      daysAgo: 3,
      dispatches: [],
    },
    {
      code: 'PD2026-0007',
      name: '瑞丰纺织设备生产线整体资产评估',
      client: '瑞丰纺织实业有限公司',
      type: '预估报告（函）',
      purpose: '资产转让',
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
        userId[p.dispatches[0]?.dispatcher ?? 'zhoulh'],
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

  console.log('[db] 已初始化演示数据：3 个部门、4 个账号、7 个评估项目');
}

function migrateDirectors(): void {
  const migration = 'directors_2026';
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migration)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const oldDept = db.prepare('SELECT id FROM departments WHERE name = ?').get('矿业权3部') as { id: number } | undefined;
    const newDept = db.prepare('SELECT id FROM departments WHERE name = ?').get('矿业权部') as { id: number } | undefined;
    if (oldDept && newDept && oldDept.id !== newDept.id) {
      throw new Error('部门名称冲突：矿业权3部与矿业权部同时存在，请先核对数据');
    }
    if (oldDept) db.prepare('UPDATE departments SET name = ? WHERE id = ?').run('矿业权部', oldDept.id);

    const directors = [
      ['zhoulh', '周利华', '业务1部'],
      ['zhaoky', '赵柯燚', '业务2部'],
      ['cunq', '寸清', '矿业权部'],
    ] as const;
    for (const [username, displayName, deptName] of directors) {
      const dept = db.prepare('SELECT id FROM departments WHERE name = ?').get(deptName) as { id: number } | undefined;
      if (!dept) throw new Error(`未找到部门：${deptName}`);
      const existing = db.prepare('SELECT display_name, role, dept_id FROM users WHERE username = ?').get(username) as
        | { display_name: string; role: string; dept_id: number | null }
        | undefined;
      if (existing) {
        if (existing.display_name !== displayName || existing.role !== 'director' || existing.dept_id !== dept.id) {
          throw new Error(`账号 ${username} 已存在且信息不匹配，请先核对账号`);
        }
      } else {
        db.prepare(
          'INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(username, hashPassword(bootstrapPassword('ORDER_RECORD_INITIAL_PASSWORD')), displayName, 'director', dept.id, now());
      }
    }
    const disableDemo = db.prepare(
      "UPDATE users SET is_active = 0, auth_version = auth_version + 1 WHERE username = ? AND display_name = ? AND role = 'director'",
    );
    for (const [username, name] of [['zhang', '张建国'], ['li', '李慧敏'], ['wang', '王振宇']]) {
      disableDemo.run(username, name);
    }
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateAdmin(): void {
  const migration = 'sysadmin_2026';
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migration)) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migration)) {
      db.exec('COMMIT');
      return;
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get('sysadmin')) {
      console.error('[db] 无法创建管理员：sysadmin 账号已存在，请先核对账号信息');
      db.exec('ROLLBACK');
      return;
    }
    // 保留旧 users 表的角色约束，管理员身份由独立关联表标识。
    const initialPasswordHash = hashPassword(bootstrapPassword('ORDER_RECORD_INITIAL_ADMIN_PASSWORD'));
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('sysadmin', initialPasswordHash, '吕洋', 'director', null, now());
    db.prepare('INSERT INTO admin_accounts (user_id) VALUES (?)').run(result.lastInsertRowid);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateReadonlyViewer(): void {
  const migration = 'readonly_licl_2026';
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migration)) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get('licl')) {
      db.prepare(
        'INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('licl', hashPassword('1234567'), '李春林', 'viewer', null, now());
    }
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// 兼容已生成过的演示数据，统一切换到新的派单单号和业务类型口径。
migrateLegacyProjectData();
migrateProjectTypeNames();
seed();
migrateDirectors();
migrateAdmin();
migrateReadonlyViewer();
