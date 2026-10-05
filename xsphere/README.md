# xsphere

xsphere 的日常开发与运维从这里开始。暂不拆分仓库；产品集成集中在 `xsphere/`，
仓库根目录的 agent-sandbox controller、CRD 和 Router 保留原样，作为依赖使用。

## 现在以哪个版本为准

以 **55 在 2026-10-04 固化的实际版本 `55-20261004`** 为依据：
基线分支 `baseline/55-20261004`，提交 `48eb265e`，chart 版本 `0.2.0`。
这是一次部署快照，后续文档整理和开发不改写它。

- [基线说明](docs/baseline.md)：实际运行内容、校验方法、复现条件和未完成事项。
- [版本清单](archive/baseline-55-20261004.json)：镜像内容摘要、运行时校验值及来源。
- [sanjxmgmt ARM64 对齐记录](archive/verification-sanjxmgmt-55-arm64-20261006.md)：
  同一 API 源码与 controller/Router 版本，保留 ARM64 业务启动方式及环境配置。
- 精确环境配置在本机忽略目录 `local/baseline-55-20261004/`；
  旧 `local/values-55.yaml` 和通用示例都不是这次基线的配置来源。

55 使用 AMD64、gVisor 和已启用的内存暂停/恢复路径；API 默认配置仍是保留 PVC、重建 Pod。
基线采集核对了源码、配置和镜像内容，没有重新执行业务会话恢复验收。

## 主干由什么组成

```text
CodeSphere / SDK → sandbox-api → Kubernetes 资源 → agent-sandbox controller
                                                   ↓
浏览器 / SDK → sandbox-edge → sandbox-router → Sandbox（envd + 业务进程）
                                                   ↓
                                              gVisor 运行时
```

| 需要处理什么 | 入口与边界 |
| --- | --- |
| 创建、暂停、恢复、连接沙箱 | [sandbox-api/](sandbox-api/)：产品 API 与内存生命周期逻辑 |
| Edge、沙箱模板、配置与看板 | [deploy/chart/](deploy/chart/)：xsphere Helm chart |
| CodeSphere 接入及业务容器启动脚本 | [deploy/codesphere/](deploy/codesphere/)：集成文件，私有应用完整源码不在这里 |
| controller、CRD、Router | 复用仓库根目录实现；当前整理不修改这些上游组件 |
| runsc 与定制 shim | [runtime/](runtime/)：外部 `Axpz/gvisor` 的版本与验证记录，源码在外部仓库 |

Postgres、Redis、MinIO 属于 CodeSphere 应用配套服务。历史实验与验证证据保留在
[archive/](archive/)，日常操作从下列入口开始。

## 日常操作去哪里

| 目的 | 阅读入口 |
| --- | --- |
| 访问现有 55 环境 | [55 访问说明](docs/access-55.md)、[监控说明](deploy/monitoring/) |
| 理解暂停、恢复及 Edge 自动唤醒 | [生命周期说明](docs/lifecycle.md) |
| 修改 API | [API 开发说明](sandbox-api/README.md) |
| 在新环境部署 xsphere chart | [部署说明](docs/deployment.md) |
| 从节点到应用搭建完整环境 | [完整搭建说明](docs/bootstrap.md) |

本地需要 Bun 1.3.5、Helm 3.16.4、Python 3.11+。在仓库根目录运行：

```sh
make -C xsphere install
make -C xsphere check
make -C xsphere render
```

`check` 执行离线检查、测试和构建；`render` 只输出清单，默认使用开发示例配置。
部署前按部署说明选择环境专用 values；本机配置放在被 Git 忽略的 `xsphere/local/`。
镜像构建使用 `make -C xsphere image`，需要 Docker。

## 尚未完成的部分

- API-key 校验与完整的数据面授权尚未接入，目前面向可信客户端的私有开发环境。
- 当前支持单 namespace、单配置池；`templateID` 只是描述字段，不负责选择不同模板。
- 内存快照和存储依赖单节点；历史快照清理、跨节点恢复及实际 chat/Pi 会话验收尚未完成。
- 55 的后端 WebSocket 地址仍需匹配最终浏览器入口。基线未备份凭据、业务数据、
  内存快照、镜像层或运行时二进制，不能单靠 Git 克隆恢复已有会话。

发布版本由 [Chart.yaml](deploy/chart/Chart.yaml) 管理：`version` 与 `appVersion`
保持一致，正式发布使用 `xsphere/vX.Y.Z` 标签；私有 sandbox-api 包不单独发布。
