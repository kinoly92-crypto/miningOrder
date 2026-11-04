# 矿业权项目派单管理平台

前端使用 React、Ant Design 和 Vite，后端使用 Node.js、Express 和 TypeScript。
本地默认使用 SQLite；也可以在完成显式迁移后使用 MySQL 8.0。

## 本地开发

```powershell
npm ci
npm run dev
```

访问 `http://localhost:5173`。默认 SQLite 文件是 `server/data/app.db`，请勿删除或提交到 Git。
通过 `ORDER_RECORD_DATA_DIR` 可指定其他 SQLite 数据目录。
首次创建 SQLite 数据库时，如未设置环境变量，系统使用默认初始密码：普通账号
`123456`，管理员账号 `4100282`。首次登录后系统会强制要求修改密码；首次初始化后
已有账号密码不会被重置。可参考 `.env.example` 配置，真实密码不得提交到仓库。

应用默认监听所有网络接口。云服务器通过本机反向代理访问时，设置
`HOST=127.0.0.1`，避免应用端口直接暴露；还需检查服务器防火墙和安全组。

## MySQL 配置

复制 `.env.example` 为 `.env`，填写 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、
`MYSQL_PASSWORD`、`MYSQL_DATABASE` 等配置。`.env` 含敏感信息，不能提交或分享。
优先使用服务器到 MySQL 的私网连接，并按需配置 `MYSQL_TLS=true` 和可信的
`MYSQL_CA_FILE`；如使用 TLS，证书必须通过验证。

迁移验证完成之前，保持 `DB_CLIENT=sqlite`。启动应用不会自动建表或导入数据。
MySQL 用户应仅拥有所需数据库权限；迁移阶段需要建表权限，运行阶段应改用权限更小的账号。

## 从 SQLite 迁移到 MySQL

1. 停止所有对源 SQLite 的写入，备份 SQLite 和目标数据库，并确认可恢复。SQLite 使用 WAL，
   运行时不能只复制 `app.db` 作为备份；应在停止写入并关闭服务后备份，或使用 SQLite 在线备份。
2. 准备一个**全新的空 MySQL 8.0 数据库**。迁移工具发现目标库存在任何表或视图时会退出，
   不会覆盖已有数据。不要在未核对的现有业务库执行。
3. 在安全环境中配置好 MySQL 连接，再显式指定 SQLite 来源和目标库确认值，例如 PowerShell：

```powershell
$env:SQLITE_SOURCE = "D:\path\to\sqlite\app.db"
$env:MYSQL_MIGRATION_CONFIRM = $env:MYSQL_DATABASE
npm run mysql:migrate -- --apply
```

如果 MySQL 连接配置写在 `.env` 而不是环境变量中，则将确认值设置为目标数据库的实际名称。
源文件必须使用绝对路径。工具读取源库一致性快照，按顺序导入平台、账号、管理员身份、项目、
派单和日志，保留 ID、密码哈希及历史关系，并核对表行数。停止写入到切换完成期间，不会自动
同步后续变更。

4. 核对 MySQL 中的账号、项目、派单、日志与操作权限，并在独立环境验证并发派单、导入导出。
   MySQL 建表不可事务回滚；如果迁移失败并留下空表，应先检查原因，切勿直接清理已有业务数据。
5. 确认迁移完成后将 `.env` 中的 `DB_CLIENT` 改为 `mysql`，重启应用并验证。保留 SQLite 备份。
   切换后产生了新写入时，不可直接切回旧 SQLite，否则会丢失这段时间的数据，需要先处理数据差异。

## 上线限制

当前系统仍需 HTTPS、所有账号使用强密码、生产 JWT 密钥及生产权限审查，不能直接开放到公网
处理真实业务数据。单进程实时同步依赖进程内状态，不支持直接扩展为多实例。
上线前还应落实域名备案、定期备份及恢复演练。

登录限制为每个客户端 IP 十分钟内最多 30 次尝试，计数保存在进程内，重启后会重置。
仅在应用只接受可信本机反向代理连接、且代理覆盖客户端提供的转发地址时，设置
`TRUST_PROXY=loopback`，并由代理将 `X-Forwarded-For` 设置为真实客户端地址。
实时连接使用短时、一次性的连接凭据，不能用于其他接口；反向代理的访问日志仍应避免记录查询字符串。
