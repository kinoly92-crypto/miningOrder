import type { ConflictInfo } from '../../shared/types';

/**
 * 业务冲突错误：与"参数填错"不同，它表示操作本身合法，
 * 但与台账中已有的事实冲突（重复派单、记录被他人改过），
 * 前端必须能把 conflict 里的上下文原样展示给主任看。
 */
export class ConflictError extends Error {
  readonly conflict: ConflictInfo;

  constructor(conflict: ConflictInfo) {
    super(conflict.message);
    this.name = 'ConflictError';
    this.conflict = conflict;
  }
}

export { inTransaction } from './storage';
