# sanjxmgmt ARM64 对齐 55 — 2026-10-06

在现有 namespace 直接完成对齐。版本依据是 55 固化提交 `48eb265e`；
ARM64 版本清单见 [lock](baseline-sanjxmgmt-55-arm64-20261006.json)，
日常入口见 [README](../README.md)。日期采用 Asia/Shanghai。

## 实际更新

| 组件 | 结果 |
| --- | --- |
| sandbox-api 与 checkpoint worker | 同一份 `48eb265e` 源码，Bun 1.3.5，ARM64 配套镜像；保留节点/runtime/path 校验，恢复不运行 verify Job |
| controller | 官方 v0.5.4 的 ARM64 manifest；与 55 同一上游多架构 index |
| Router | 从 55 实际运行的 `afc6c6a` 源码构建，Go 1.26.4，ARM64；源码与本次产品基线对应目录一致 |
| Edge | 接入 connect 自动唤醒、409→503/Retry-After、请求体配置；保留主域、preview 与 `/lite` 路由，限制单 worker |
| base 镜像与模板 | 在既有 ARM64 base 上加入 tini、envd 监督循环、恢复钩子、startup/readiness 探针，关闭 Pod SA token 自动挂载 |

base 使用 [Dockerfile.overlay](../deploy/codesphere/runtime/Dockerfile.overlay)。
原 envd 0.6.9 二进制、业务 daemon 启动脚本和 Jupyter 启动脚本校验值保持一致。
ARM64 daemon 的入口与 55 不同，因此保留其自动启动方式，不覆盖为 55 的旧业务启动协议。
保留 sanjxmgmt 的 workspace 路径、FUSE/privileged 配置、存储、域名和已验证的 gVisor
`release-20260817.0` ARM64 组合。CodeSphere 前后端沿用原有 ARM64 镜像。

部署镜像使用固定 digest。controller 的多架构 Docker 导出缺少 ARM64 blobs，
最终通过节点 containerd 拉取官方 ARM64 manifest 并验证内容，未使用 x86 manifest。
上游仓库代码和 CRD schema 没有修改。

## 本轮验证

- 离线 `make -C xsphere check`：50 Bun 测试、21 Python 测试、类型检查、构建和 Helm lint 通过；7 个已有 Biome warning。
- 运行 API 的 13 个 TypeScript 文件、package.json 和 bun.lock 与固定源码逐字节一致。
- 通过现有 CodeSphere Gateway/SDK 创建、执行命令、暂停、恢复和删除验证沙箱。
- 最终组合的 SDK 恢复和双并发 Edge 自动唤醒均保留 8 MiB 随机内存 SHA、进程标识、PID 与冻结计数器；解冻后计数器从 1012 增至 1015。
- 暂停后旧 Pod 消失；恢复后 Pod UID 改变、卷配置相同、container restartCount 为 0。Edge 的 header 和 wildcard 两条路径均返回 204。
- 最终组合暂停为 6.0/6.6 秒；SDK 恢复 34.2 秒、并发 Edge 唤醒 33.7 秒。冷启动创建 7.9 秒。
- 主域 `/workspace/` 与 `/lite/` 经 Edge 返回 200。22 个既有非预热池 Sandbox/Claim UID 保持一致，两个既有业务 Pod UID 保持一致。
- 验证沙箱已删除，其自身 checkpoint 目录已清理；业务会话和旧快照未执行暂停、恢复或删除操作。预热池恢复到 1 个 Ready。

没有执行真实 chat/Pi 会话验收、数据迁移、故障恢复验收或公网浏览器端完整链路测试。
上述记录不声明两个 CodeSphere 私有应用源码版本完全一致。

## 固化与回退

在引入本记录的基线提交运行：

```sh
make -C xsphere baseline-check BASELINE=sanjxmgmt-55-arm64-20261006
make -C xsphere baseline-local-check BASELINE=sanjxmgmt-55-arm64-20261006
```

精确配置、变更前后快照、回退 patch、构建输入与验证证据保存在被 Git 忽略的
`xsphere/local/baseline-sanjxmgmt-55-arm64-20261006/`，内容由 tracked lock 和 checksum 绑定。
回退前检查 journal 无进行中的操作及后续配置差异；API 镜像与 worker 配置必须一起回退。
新 base 只用于新建沙箱，既有已领取沙箱保留原镜像与模板。

没有复制 Secret、业务数据、内存 dump、镜像层或运行时二进制，也未发布镜像。
这是一份源码/配置基线；完整重建仍需要原 ARM64 base、私有应用镜像和运行时产物。
