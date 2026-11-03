# xsphere

日常维护分支为 **`xsphere/main`**。当前发布 **1103.1**，组件版本与镜像摘要见
[`release.json`](release.json)。Helm 要求三段版本号，因此 chart 为 `1103.1.0`，
`appVersion` 与 Git tag 均为 `1103.1`。

| 内容 | 维护入口 |
| --- | --- |
| sandbox-api：SDK 兼容、创建、暂停/恢复与快照任务 | [sandbox-api/](sandbox-api/) |
| Edge、模板、热池与监控面板 | [deploy/chart/](deploy/chart/) |
| K3s 命名空间、上游组件接入与部署示例 | [docs/k3s.md](docs/k3s.md) |
| Controller、CRD、Router | 仓库根目录的上游实现与工具链 |
| runsc 与恢复 shim | 外部 [Axpz/gvisor](https://github.com/Axpz/gvisor/tree/xsphere/main)，本仓库仅[引用版本](runtime/README.md) |

```text
CodeSphere / SDK → sandbox-api → Kubernetes → Controller → Sandbox Pod + PVC
SDK / 浏览器 → Edge → 上游 Router → Sandbox
                                     ↓
                                  gvisor-x
```

## 验证与发布

```sh
make -C xsphere install
make -C xsphere check
make -C xsphere render
```

`check` 是离线检查。K3s 使用[专用示例](deploy/values-k3s.example.yaml)，
Router 使用[上游 chart values](deploy/values-router.example.yaml)。通用单命名空间
开发配置继续支持，操作说明见 [deployment](docs/deployment.md)。

正式发布使用不可变 tag 与 GitHub Release；发布清单分别固定上游组件、API 镜像和
外部 gVisor 版本，不因整套版本号变化就重建所有组件。`1103.1` 的 API 运行代码与
`1029.1` 相同；gVisor 也复用 `1029.1` 的提交和安装包。

环境域名、节点、registry 与配置保存在忽略的 `local/` 或私有环境仓库，凭据和 TLS
私钥使用现有 Secret。CodeSphere 前后端源码、用户文件和数据库继续在各自系统维护。
部署前渲染比较，评估现有资源归属和回退；发布源码不代表集群已升级。

## 边界

API 面向可信私有客户端，完整租户鉴权尚未实现。内存快照依赖节点上的兼容运行时、
镜像与快照文件；见[生命周期说明](docs/lifecycle.md)。本次整理不新增线上恢复测试。
历史安装与验证记录保留在 [archive/](archive/) 和[冻结基线说明](docs/baseline.md)。
