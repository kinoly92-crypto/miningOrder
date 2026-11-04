import { Router } from 'express';
import dayjs from 'dayjs';
import * as XLSX from 'xlsx';
import { monthStartIso } from '../common';
import { all } from '../storage';
import { asyncRoute } from '../async-route';
import { requireDirector } from '../middleware';
import { listDepartments, loadDispatches, loadProjects } from '../repo';
import { AUDIT_ACTION_META } from '../../../shared/audit-actions';
import type { AuditLog, DispatchStatus, StatsOverview } from '../../../shared/types';

const router = Router();

router.get('/stats', asyncRoute(async (_req, res) => {
  const projects = await loadProjects();
  const dispatches = await loadDispatches();
  const monthStart = monthStartIso();

  const pendingProjects = projects.filter((p) => p.status === 'pending').length;
  const doneProjects = projects.filter((p) => p.status === 'done').length;
  const terminatedProjects = projects.filter((p) => p.status === 'terminated').length;

  const byDept = (await listDepartments()).map((dept) => {
    const list = dispatches.filter((d) => d.deptId === dept.id);
    return {
      deptId: dept.id,
      deptName: dept.name,
      monthDispatched: list.filter((d) => d.status !== 'terminated' && d.dispatchedAt >= monthStart).length,
      dispatched: list.filter((d) => d.status === 'dispatched').length,
      done: list.filter((d) => d.status === 'done').length,
    };
  });

  const statuses: DispatchStatus[] = ['dispatched', 'done', 'terminated'];
  const byStatus = statuses.map((status) => ({
    status,
    count: dispatches.filter((d) => d.status === status).length,
  }));

  const overview: StatsOverview = {
    totalProjects: projects.length,
    pendingProjects,
    activeProjects: projects.filter((p) => p.status === 'dispatched').length,
    doneProjects,
    terminatedProjects,
    monthDispatched: dispatches.filter((d) => d.status !== 'terminated' && d.dispatchedAt >= monthStart).length,
    byDept,
    byStatus,
  };

  res.json({ success: true, data: overview });
}));

router.get('/audit-logs', requireDirector, asyncRoute(async (req, res) => {
  const limit = Math.floor(Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 1000));
  const rows = await all<{
    id: number;
    user_id: number | null;
    user_name: string | null;
    action: string;
    target_type: string;
    target_id: number | null;
    detail: string | null;
    created_at: string;
  }>(
      `SELECT id, user_id, user_name, action, target_type, target_id, detail, created_at
       FROM audit_logs ORDER BY id DESC LIMIT ?`,
    [limit],
  );

  const logs: AuditLog[] = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));

  res.json({ success: true, data: logs });
}));

router.get('/audit-logs/export', requireDirector, asyncRoute(async (_req, res) => {
  const rows = await all<{
    user_name: string | null;
    action: string;
    detail: string | null;
    created_at: string;
  }>(
    'SELECT user_name, action, detail, created_at FROM audit_logs ORDER BY id DESC',
  );

  const headers = ['时间', '操作人', '操作类型', '操作内容'];
  const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
    时间: dayjs(row.created_at).format('YYYY-MM-DD HH:mm:ss'),
    操作人: row.user_name ?? '',
    操作类型: AUDIT_ACTION_META[row.action]?.label ?? row.action,
    操作内容: row.detail ?? '',
  })), { header: headers });
  sheet['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 16 }, { wch: 70 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '操作日志');
  const filename = `操作日志_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.end(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
}));

export default router;
