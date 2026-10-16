# Sandbox 基础链路核对 — 2026-10-16

范围：GitHub 源码边界、gVisor、controller/CRD、sandbox-api、Edge、Router。
本记录不整理应用、SSO、模型网关或技能广场。

## 只读环境核对

| 项目 | sanjxmgmt | 14-xsphere-k3s | sparkorma |
| --- | --- | --- | --- |
| 架构 | ARM64 | AMD64 | ARM64 |
| 集群 | 单节点 kind / Kubernetes 1.36.1 | 单节点 kind / Kubernetes 1.37.0 | 单节点 kind / Kubernetes 1.37.0 |
| 主 API | sandbox/sandbox-api，摘要 0f53d6af… | envdinit-20261013 | envdinit-20261013 |
| 主 API 的 TS 源码与整理前工作区比较 | 13 个文件中 6 个不同，另缺 envd.ts | 14 个文件全部一致 | 14 个文件全部一致 |
| 主业务预热池期望/就绪 | 1/1 | 5/5 | 1/1 |
| 主业务存储 | local-path | OpenEBS LVM | OpenEBS LVM |
| API 配置的 runsc SHA 前缀 | d5679775682c | 1a4995a70b3c | d5679775682c |

比较的是线上读取到的 TS 源码，不是整个镜像、依赖、运行时二进制或业务能力。
本次未重新计算节点 runsc/shim 的实际校验值；上表运行时值来自 API 配置。
既有运行时版本依据仍见 [runtime/](../runtime/README.md)。

sanjxmgmt 不同的文件是 `app.ts`、`config.ts`、`contract/routes.ts`、
`checkpoint/lifecycle.ts`、`k8s/backend.ts`、`metrics.ts`。
没有把这些差异直接判定为故障或执行统一升级。

## 本次提交边界

整理现有核心工作：E2B v2 创建入口、可选 envd /init、创建/删除指标、runtime 身份注入
和恢复钩子，以及来源和维护说明。保留既有路径、Service、资源所有权与 SDK 字段。

整理前工作区另有一项变更：内存生命周期扫描由约 2 秒改为默认 15 分钟，并调整扫描
执行方式。它会改变自动暂停与中断操作恢复的等待预算，**不纳入本次提交**，仍待单独
兼容性评审。因此本次提交并不声称与 14/sparkorma 的整个线上 API 源码完全一致。

应用补丁、desktop 实验、看板样式和客户访问说明也不属于这次基础链路提交；保留原有
工作区材料，不删除、不重置，也不一并暂存。

## 已知故障与证据范围

此前在 sparkorma 做过两组验证，本次没有重跑：

- Running 时 VM 重启出现 Unknown/255；只重建 Pod 后，6 个工作盘共 1,498 个文件校验一致。
- 已暂停实例跨 VM 重启后仍 paused，正常 resume 成功，247 个文件校验一致；但再次 pause
  的保存任务 180 秒超时，原有效 checkpoint 保留，实例回退仍待用户确认。

这不是完整业务会话内存连续性或物理宿主重启验收。保存超时与 Running 重启恢复是独立
待办；没有将候选 checkpoint 补丁、开机恢复脚本或 Always 策略作为已完成修复。

sanjxmgmt 另有实验 API、已缩容的 memory API 和独立 lite 业务。它们的用途、调用方和
数据归属需要逐一确认，不按名称直接删除。本轮未修改集群或运行时。

## 提交验证

从 Git 暂存区导出独立目录，复用本地已安装依赖运行 `make -C xsphere check`：
62 项 Bun 测试、21 项 Python 测试、类型检查、构建和 Helm 严格检查全部通过。
Biome 保留 7 项既有测试代码警告，无错误。该验证未包含工作区中未暂存的改动，
也未执行部署、节点重启或线上 E2E。
