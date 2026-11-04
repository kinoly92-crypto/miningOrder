// MySQL 8.0: 建表仅由显式迁移命令执行，应用启动不会改动数据库结构。
export const MYSQL_SCHEMA = [
  `CREATE TABLE app_schema (
    id TINYINT NOT NULL PRIMARY KEY,
    version INTEGER NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE app_locks (
    id TINYINT NOT NULL PRIMARY KEY
  ) ENGINE=InnoDB`,
  `CREATE TABLE departments (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE users (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL,
    dept_id BIGINT NULL,
    created_at VARCHAR(32) NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    auth_version INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT users_dept_fk FOREIGN KEY (dept_id) REFERENCES departments(id),
    CONSTRAINT users_role_check CHECK (role IN ('director', 'viewer'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE admin_accounts (
    user_id BIGINT NOT NULL PRIMARY KEY,
    CONSTRAINT admins_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE projects (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    project_code VARCHAR(40) NOT NULL UNIQUE,
    project_name TEXT NOT NULL,
    client_name TEXT NULL,
    client_contact TEXT NULL,
    client_phone TEXT NULL,
    business_source TEXT NULL,
    business_level VARCHAR(20) NULL,
    project_type VARCHAR(100) NOT NULL,
    eval_purpose TEXT NULL,
    estimated_fee DOUBLE NULL,
    deadline VARCHAR(32) NULL,
    created_by BIGINT NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL,
    pending_reset INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT projects_user_fk FOREIGN KEY (created_by) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE dispatches (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT NOT NULL,
    dept_id BIGINT NOT NULL,
    assignee TEXT NOT NULL,
    team_members TEXT NULL,
    signatory_one TEXT NULL,
    signatory_two TEXT NULL,
    dispatcher_id BIGINT NOT NULL,
    dispatched_at VARCHAR(32) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'dispatched',
    remark TEXT NULL,
    actual_completion_date TEXT NULL,
    updated_at VARCHAR(32) NOT NULL,
    active_dept_id BIGINT GENERATED ALWAYS AS
      (CASE WHEN status <> 'terminated' THEN dept_id ELSE NULL END) STORED,
    UNIQUE KEY idx_dispatches_active_unique (project_id, active_dept_id),
    KEY idx_dispatches_project (project_id),
    CONSTRAINT dispatch_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT dispatch_dept_fk FOREIGN KEY (dept_id) REFERENCES departments(id),
    CONSTRAINT dispatch_user_fk FOREIGN KEY (dispatcher_id) REFERENCES users(id),
    CONSTRAINT dispatch_status_check CHECK (status IN ('dispatched', 'done', 'terminated'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE audit_logs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL,
    user_name TEXT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(100) NOT NULL,
    target_id BIGINT NULL,
    detail TEXT NULL,
    created_at VARCHAR(32) NOT NULL,
    KEY idx_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
] as const;
