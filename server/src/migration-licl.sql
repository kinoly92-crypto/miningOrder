-- 添加只读账户 licl（李春林），密码 1234567
-- 只读账户仅可查看与导出，不可新增/编辑项目，也不显示操作日志。
-- 该脚本幂等，可重复执行。
INSERT INTO users (username, password_hash, display_name, role, dept_id, created_at)
SELECT 'licl', '0a8b1820b931ee6bbc33013534f7427a:f6190906a496032a2bc0646a2d61fc9f2254862f815d45f578e854f3ee8c4a25a4966ff001caabf76d6e00ebb7543f56271a074dd4ae12a604270ca9f0fd4791', '李春林', 'viewer', NULL, NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'licl');
