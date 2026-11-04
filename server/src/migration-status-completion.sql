-- 合并「执行中」到「已派单」，并新增「实际完成日期」字段。
-- 执行前务必先通过宝塔备份数据库并核对；每条 DDL 独立提交，中断后请逐表核对。

-- 1. 合并派单状态：执行中 → 已派单
UPDATE dispatches SET status = 'dispatched' WHERE status = 'in_progress';

-- 2. 新增「实际完成日期」字段
ALTER TABLE dispatches
  ADD COLUMN actual_completion_date TEXT NULL;

-- 3. 更新状态 CHECK 约束（移除「执行中」）
ALTER TABLE dispatches DROP CHECK dispatch_status_check;
ALTER TABLE dispatches
  ADD CONSTRAINT dispatch_status_check CHECK (status IN ('dispatched', 'done', 'terminated'));
