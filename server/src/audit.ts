import { now } from './common';
import { execute } from './storage';
import type { User } from '../../shared/types';

/**
 * 审计日志：所有会改变台账的写操作都必须留下痕迹，
 * 这是"派单信息准确、可追责"的最后一道保险。
 */
export async function writeAudit(params: {
  user?: User;
  action: string;
  targetType: string;
  targetId?: number | null;
  detail?: string;
}): Promise<void> {
  await execute(
    `INSERT INTO audit_logs (user_id, user_name, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [
    params.user?.id ?? null,
    params.user?.displayName ?? null,
    params.action,
    params.targetType,
    params.targetId ?? null,
    params.detail ?? null,
    now(),
  ]);
}
