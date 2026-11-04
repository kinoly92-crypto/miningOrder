import { writeAudit } from './audit';
import { generateDispatchNo, isOptionalText, isSingleAssignee, isValidBusinessLevel, isValidDispatchNo, isValidProjectType, now } from './common';
import { execute, lockDispatchCreation } from './storage';
import { ConflictError, inTransaction } from './errors';
import { findActiveDispatch, findProjectByCode, loadProjectById, listDepartments } from './repo';
import type { DispatchEntryInput, Project, User } from '../../shared/types';

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function fee(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function createDispatchEntry(body: DispatchEntryInput, user: User): Promise<Project> {
  const input = body.dispatch;
  if (!isOptionalText(body.project?.clientContact, 100) || !isOptionalText(body.project?.clientPhone, 60) ||
      !isOptionalText(body.project?.businessSource, 200) ||
      !isOptionalText(input?.teamMembers, 500) || !isOptionalText(input?.signatoryOne, 80) ||
      !isOptionalText(input?.signatoryTwo, 80)) {
    throw new Error('INVALID_ADDITIONAL_FIELDS');
  }
  if ((!input && body.projectId) || (input && (typeof input.deptId !== 'number' || !isSingleAssignee(input.assignee)))) {
    throw new Error('INVALID_DISPATCH_INPUT');
  }

  const dept = input ? (await listDepartments()).find((d) => d.id === input.deptId) : undefined;
  if (input && !dept) {
    throw new Error('INVALID_DEPARTMENT');
  }

  return inTransaction(async () => {
    await lockDispatchCreation();
    let projectId: number;

    if (body.projectId) {
      const existing = await loadProjectById(body.projectId);
      if (!existing) {
        throw new ConflictError({ kind: 'stale-record', message: '该项目已被删除或不存在，请刷新台账后重试' });
      }
      projectId = existing.id;
    } else {
      const p = body.project;
      const code = text(p?.projectCode) ?? await generateDispatchNo();
      const name = text(p?.projectName);
      const projectType = text(p?.projectType);
      if (!code || !name) {
        throw new Error('EMPTY_PROJECT_FIELDS');
      }
      if (!isValidDispatchNo(code)) {
        throw new Error('INVALID_DISPATCH_NO');
      }
      if (!isValidProjectType(projectType)) {
        throw new Error('INVALID_PROJECT_TYPE');
      }
      if (!isValidBusinessLevel(text(p?.businessLevel))) {
        throw new Error('INVALID_BUSINESS_LEVEL');
      }
      const duplicate = await findProjectByCode(code);
      if (duplicate) {
        throw new ConflictError({
          kind: 'project-code-exists',
          message: `派单单号 ${code} 已建档，不能重复建档，请改为对该记录追加派单`,
          project: duplicate,
        });
      }
      const ts = now();
      projectId = (await execute(
            `INSERT INTO projects
               (project_code, project_name, client_name, client_contact, client_phone, business_source, business_level, project_type, eval_purpose, estimated_fee, deadline, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            code,
            name,
            text(p?.clientName),
            text(p?.clientContact),
            text(p?.clientPhone),
            text(p?.businessSource),
            text(p?.businessLevel),
            projectType,
            text(p?.evalPurpose),
            fee(p?.estimatedFee),
            text(p?.deadline),
            user.id,
            ts,
            ts,
          ],
      )).insertId;
      await writeAudit({
        user,
        action: 'create-project',
        targetType: 'project',
        targetId: projectId,
        detail: `录入派单 ${code}《${name}》`,
      });
    }

    if (!input) return (await loadProjectById(projectId))!;

    const duplicateDispatch = await findActiveDispatch(projectId, input.deptId);
    if (duplicateDispatch) {
      throw new ConflictError({
        kind: 'duplicate-dispatch',
        message: `该项目已派给${duplicateDispatch.deptName}（负责人 ${duplicateDispatch.assignee}，${duplicateDispatch.dispatchedAt} 由 ${duplicateDispatch.dispatcherName} 派单），请勿重复派单`,
        project: await loadProjectById(projectId),
        dispatch: duplicateDispatch,
      });
    }

    const ts = now();
    const dispatchId = (await execute(
          `INSERT INTO dispatches
             (project_id, dept_id, assignee, team_members, signatory_one, signatory_two, dispatcher_id, dispatched_at, status, remark, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
      [projectId, input.deptId, text(input.assignee)!, text(input.teamMembers), text(input.signatoryOne), text(input.signatoryTwo), user.id, ts, text(input.remark), ts],
    )).insertId;
    await execute('UPDATE projects SET pending_reset = 0, updated_at = ? WHERE id = ?', [ts, projectId]);

    const created = (await loadProjectById(projectId))!;
    await writeAudit({
      user,
      action: 'create-dispatch',
      targetType: 'dispatch',
      targetId: dispatchId,
      detail: `将 ${created.projectCode}《${created.projectName}》派给${dept!.name}，负责人 ${text(input.assignee)}`,
    });

    return created;
  });
}
