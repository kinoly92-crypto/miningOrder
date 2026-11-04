-- 交付成果类型改名：旧类型 → 新类型
-- 执行前请先通过宝塔备份数据库；以下 UPDATE 幂等，可重复执行。
UPDATE projects SET project_type = '资产评估报告' WHERE project_type = '资产评估';
UPDATE projects SET project_type = '房地产估价报告（含租金）' WHERE project_type = '房地产估价';
UPDATE projects SET project_type = '房地产估价报告（含租金）' WHERE project_type = '房地产估价（含租金）';
UPDATE projects SET project_type = '土地估价报告' WHERE project_type = '土地估价';
UPDATE projects SET project_type = '债权分析报告' WHERE project_type = '债权分析';
UPDATE projects SET project_type = '咨询报告' WHERE project_type = '咨询';
UPDATE projects SET project_type = '预估报告（函）' WHERE project_type = '预估';
-- 注：矿业权报告 名称保持不变，无需更新。
