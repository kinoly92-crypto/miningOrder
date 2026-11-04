import { all, one } from './storage';
import type { BusinessLevel, DispatchRecord, DispatchStatus, Project, ProjectStatus, ProjectType } from '../../shared/types';

interface ProjectRow {
  id: number;
  project_code: string;
  project_name: string;
  client_name: string | null;
  client_contact: string | null;
  client_phone: string | null;
  business_source: string | null;
  business_level: BusinessLevel | null;
  project_type: ProjectType;
  eval_purpose: string | null;
  estimated_fee: number | null;
  deadline: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
  pending_reset: number;
  created_by_name: string | null;
}

interface DispatchRow {
  id: number;
  project_id: number;
  dept_id: number;
  assignee: string;
  team_members: string | null;
  signatory_one: string | null;
  signatory_two: string | null;
  dispatcher_id: number;
  dispatched_at: string;
  status: DispatchStatus;
  remark: string | null;
  actual_completion_date: string | null;
  updated_at: string;
  dept_name: string;
  dispatcher_name: string;
  project_code: string;
  project_name: string;
}

const PROJECT_SELECT = `
  SELECT p.id, p.project_code, p.project_name, p.client_name, p.client_contact, p.client_phone, p.business_source, p.business_level, p.project_type,
         p.eval_purpose, p.estimated_fee, p.deadline, p.created_by, p.created_at, p.updated_at, p.pending_reset,
         u.display_name AS created_by_name
  FROM projects p
  LEFT JOIN users u ON u.id = p.created_by
`;

const DISPATCH_SELECT = `
  SELECT d.id, d.project_id, d.dept_id, d.assignee, d.team_members, d.signatory_one, d.signatory_two, d.dispatcher_id, d.dispatched_at,
         d.status, d.remark, d.actual_completion_date, d.updated_at,
         dept.name AS dept_name,
         u.display_name AS dispatcher_name,
         p.project_code, p.project_name
  FROM dispatches d
  JOIN departments dept ON dept.id = d.dept_id
  JOIN users u ON u.id = d.dispatcher_id
  JOIN projects p ON p.id = d.project_id
`;

function mapDispatch(row: DispatchRow): DispatchRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectCode: row.project_code,
    projectName: row.project_name,
    deptId: row.dept_id,
    deptName: row.dept_name,
    assignee: row.assignee,
    teamMembers: row.team_members,
    signatoryOne: row.signatory_one,
    signatoryTwo: row.signatory_two,
    dispatcherId: row.dispatcher_id,
    dispatcherName: row.dispatcher_name,
    dispatchedAt: row.dispatched_at,
    status: row.status,
    remark: row.remark,
    actualCompletionDate: row.actual_completion_date,
    updatedAt: row.updated_at,
  };
}

/**
 * 标记 0 为按派单推导，1 为恢复待派单，2 为撤销尚未派单的项目。
 */
export function deriveProjectStatus(dispatches: DispatchRecord[], pendingReset = 0): ProjectStatus {
  const active = dispatches.filter((d) => d.status !== 'terminated');
  if (active.length === 0) {
    if (pendingReset === 2) return 'terminated';
    return dispatches.length === 0 || pendingReset === 1 ? 'pending' : 'terminated';
  }
  if (active.every((d) => d.status === 'done')) return 'done';
  return 'dispatched';
}

function mapProject(row: ProjectRow, dispatches: DispatchRecord[]): Project {
  return {
    id: row.id,
    projectCode: row.project_code,
    projectName: row.project_name,
    clientName: row.client_name,
    clientContact: row.client_contact,
    clientPhone: row.client_phone,
    businessSource: row.business_source,
    businessLevel: row.business_level,
    projectType: row.project_type,
    evalPurpose: row.eval_purpose,
    estimatedFee: row.estimated_fee,
    deadline: row.deadline,
    status: deriveProjectStatus(dispatches, row.pending_reset),
    createdById: row.created_by,
    createdByName: row.created_by_name ?? '—',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatches,
  };
}

export async function loadProjects(): Promise<Project[]> {
  const projectRows = await all<ProjectRow>(`${PROJECT_SELECT} ORDER BY p.created_at DESC`);
  const dispatchRows = await all<DispatchRow>(`${DISPATCH_SELECT} ORDER BY d.dispatched_at DESC`);

  const grouped = new Map<number, DispatchRecord[]>();
  for (const row of dispatchRows) {
    const list = grouped.get(row.project_id);
    if (list) list.push(mapDispatch(row));
    else grouped.set(row.project_id, [mapDispatch(row)]);
  }

  return projectRows.map((row) => mapProject(row, grouped.get(row.id) ?? []));
}

export async function loadProjectById(id: number): Promise<Project | undefined> {
  const row = await one<ProjectRow>(`${PROJECT_SELECT} WHERE p.id = ?`, [id]);
  if (!row) return undefined;
  const rows = await all<DispatchRow>(`${DISPATCH_SELECT} WHERE d.project_id = ? ORDER BY d.dispatched_at DESC`, [id]);
  return mapProject(row, rows.map(mapDispatch));
}

export async function findProjectByCode(code: string): Promise<Project | undefined> {
  const row = await one<ProjectRow>(`${PROJECT_SELECT} WHERE p.project_code = ?`, [code]);
  if (!row) return undefined;
  const rows = await all<DispatchRow>(`${DISPATCH_SELECT} WHERE d.project_id = ? ORDER BY d.dispatched_at DESC`, [row.id]);
  return mapProject(row, rows.map(mapDispatch));
}

export async function loadDispatches(): Promise<DispatchRecord[]> {
  const rows = await all<DispatchRow>(`${DISPATCH_SELECT} ORDER BY d.dispatched_at DESC`);
  return rows.map(mapDispatch);
}

/** 查"有效"派单（已撤销的不算），与部分唯一索引的判定口径保持一致 */
export async function findActiveDispatch(projectId: number, deptId: number): Promise<DispatchRecord | undefined> {
  const row = await one<DispatchRow>(
    `${DISPATCH_SELECT} WHERE d.project_id = ? AND d.dept_id = ? AND d.status <> 'terminated'`,
    [projectId, deptId],
  );
  return row ? mapDispatch(row) : undefined;
}

export async function findDispatchById(id: number): Promise<DispatchRecord | undefined> {
  const row = await one<DispatchRow>(`${DISPATCH_SELECT} WHERE d.id = ?`, [id]);
  return row ? mapDispatch(row) : undefined;
}

export async function listDepartments(): Promise<{ id: number; name: string }[]> {
  return all<{ id: number; name: string }>('SELECT id, name FROM departments ORDER BY id');
}
