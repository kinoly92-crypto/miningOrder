/**
 * 前后端共享的数据契约。
 * 本文件只允许包含类型定义（编译后会被完全擦除），
 * 这样浏览器端与 Node 端都能安全引用，不会产生运行时依赖。
 */

/** 角色：管理员 / 部门主任 / 只读 */
export type Role = 'admin' | 'director' | 'viewer';

/** 项目整体状态由派单记录和手动恢复待派单标记共同决定。 */
export type ProjectStatus = 'pending' | 'dispatched' | 'done' | 'terminated';

/** 单条派单记录的状态 */
export type DispatchStatus = 'dispatched' | 'done' | 'terminated';
export type ProjectType = '资产评估报告' | '房地产估价报告（含租金）' | '土地估价报告' | '矿业权报告' | '债权分析报告' | '咨询报告' | '预估报告（函）';

/** 业务程度 */
export type BusinessLevel = 'A类' | 'B类' | 'C类';

export interface Department {
  id: number;
  name: string;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  deptId: number | null;
  deptName: string | null;
}

export interface DispatchRecord {
  id: number;
  projectId: number;
  projectCode: string;
  projectName: string;
  deptId: number;
  deptName: string;
  assignee: string;
  teamMembers: string | null;
  signatoryOne: string | null;
  signatoryTwo: string | null;
  dispatcherId: number;
  dispatcherName: string;
  dispatchedAt: string;
  status: DispatchStatus;
  remark: string | null;
  actualCompletionDate: string | null;
  updatedAt: string;
}

export interface Project {
  id: number;
  projectCode: string;
  projectName: string;
  clientName: string | null;
  clientContact: string | null;
  clientPhone: string | null;
  businessSource: string | null;
  businessLevel: BusinessLevel | null;
  projectType: ProjectType;
  evalPurpose: string | null;
  estimatedFee: number | null;
  deadline: string | null;
  status: ProjectStatus;
  createdById: number;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  dispatches: DispatchRecord[];
}

/** 派单登记：新建项目并同时派单，或对已有项目追加派单 */
export interface DispatchEntryInput {
  projectId?: number;
  project?: {
    projectCode?: string;
    projectName: string;
    clientName?: string | null;
    clientContact?: string | null;
    clientPhone?: string | null;
    businessSource?: string | null;
    businessLevel?: BusinessLevel | null;
    projectType: ProjectType;
    evalPurpose?: string | null;
    estimatedFee?: number | null;
    deadline?: string | null;
  };
  dispatch?: {
    deptId: number;
    assignee: string;
    teamMembers?: string | null;
    signatoryOne?: string | null;
    signatoryTwo?: string | null;
    remark?: string | null;
  };
}

/** 冲突信息：服务端拒绝写入时返回的结构化原因，前端据此给出精确提示 */
export interface ConflictInfo {
  kind: 'project-code-exists' | 'duplicate-dispatch' | 'stale-record';
  message: string;
  project?: Project;
  dispatch?: DispatchRecord;
}

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  conflict?: ConflictInfo;
}

export interface DeptStat {
  deptId: number;
  deptName: string;
  monthDispatched: number;
  dispatched: number;
  done: number;
}

export interface StatsOverview {
  totalProjects: number;
  pendingProjects: number;
  activeProjects: number;
  doneProjects: number;
  terminatedProjects: number;
  monthDispatched: number;
  byDept: DeptStat[];
  byStatus: { status: DispatchStatus; count: number }[];
}

export interface AuditLog {
  id: number;
  userId: number | null;
  userName: string | null;
  action: string;
  targetType: string;
  targetId: number | null;
  detail: string | null;
  createdAt: string;
}

export interface BatchImportRowResult {
  rowNumber: number;
  dispatchNo?: string;
  success: boolean;
  message: string;
}

export interface BatchImportResult {
  total: number;
  successCount: number;
  failureCount: number;
  rows: BatchImportRowResult[];
}
