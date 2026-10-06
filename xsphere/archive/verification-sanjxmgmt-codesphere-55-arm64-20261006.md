# sanjxmgmt CodeSphere 前后端对齐 55 — 2026-10-06

这是 `sanjxmgmt-55-arm64-20261006` 沙箱基线之后的应用升级，不改写原基线。
目标为 55 的实际运行内容；没有使用本地工作区的其他未提交改动。

## 交付内容

- 后端：从 55 Pod 采集实际 Python 源码，包括 `_sandbox_assets.py` 的挂载热修复。
  对应的依赖锁来自 `f216d688`；81 个已安装依赖版本与 55 完全一致。
  该 Git 提交不能独自复现运行内容：55 还包含热修复和两个额外 auth0 模块。
- 前端：直接复用 55 的 232 个静态文件，逐文件 SHA256 一致；使用 ARM64 Nginx 托管。
  未确认该前端构建对应的完整 Git 提交，不以镜像标签冒充源码版本。
- Python 3.13.15、Nginx 1.31.6 均与 55 一致。两个应用镜像均为 ARM64，部署使用 digest。
- 保留 sanjxmgmt 的 Postgres、Redis、MinIO、Secret、域名和 Service。
  本地登录与 55 使用同一会话 API；移除旧 `DEV_AUTH_BYPASS` 配置。
- 唯一新增的应用源码适配为
  [本地用户 ID 补丁](../deploy/codesphere/backend-local-user.patch)：
  `CODESPHERE_LOCAL_USER_ID` 未设置时仍使用 55 的 `local-user`；
  sanjxmgmt 设置为原用户 ID，保持项目归属，无需改写用户和业务记录。

## 数据与验证

数据库从 `6e1b2d4c9f01` 迁至 `36ae79718683`，与 55 一致。先完成 dump 恢复与
16 步迁移演练，再停止后端写入、重新备份并迁移正式库。用户模型配置不存在重复行；
迁移的合并重复配置分支未删除实际记录。

升级前后记录数一致：用户 1、项目 26、沙箱记录 24、文件 82、文件夹 23。
本地登录返回原用户，项目列表展示全部 5 个未删除项目；其余项目的软删除记录保留。
原有 25 个 Sandbox/Claim 的 UID 全部保留。

最终部署验证：

- 前后端 Deployment 均 Ready；登录、用户信息、项目列表 API 返回 200。
- `/workspace/`、`/workspace/skills`、`/workspace/skills/` 返回 SPA 页面。
- 后端源码 486 个文件（含上述适配）、前端 232 个文件和 81 个依赖版本逐一核对。
- Gateway/SDK 创建沙箱、执行命令、删除沙箱正常。
- 使用后端 bootstrap/start 代码启动 daemon，健康检查 200，
  `codesphere.pi-rpc.v1` WebSocket 收到 hello、发送 hello_ack、ping 成功。
- 临时验证沙箱、Job 和数据库副本已清理；既有业务沙箱未主动暂停、恢复或删除。

没有执行真实 LLM 对话或浏览器交互验收；本次未更改 daemon/base 模板或恢复钩子。
此前约 34 秒的恢复等待问题仍属于后续 runtime 优化，不以此次前后端验收替代。

## 固化与回退

镜像 digest、文件集合摘要和依赖版本见
[应用版本清单](alignment-sanjxmgmt-codesphere-55-arm64-20261006.json)。

构建时移除 `.DS_Store`，应用源码之外的环境文件、业务数据不进入镜像。
私有源码归档、构建输入和校验记录在本机 `xsphere/local/codesphere-align-20261006/`。
服务器 `/root/xsphere-alignment/codesphere-20261006/` 保存原 Deployment、ConfigMap、
迁移日志和两份数据库 dump；数据库备份仅保留在 sanjxmgmt，目录 0700、备份 0600。
回退需同时评估 schema 和升级后的新数据，不能只切回旧镜像。历史冻结镜像未覆盖。
