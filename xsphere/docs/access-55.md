# 参考环境（55）实际访问方式

[bootstrap.md](bootstrap.md) 的 Access 章节是通用写法；这一份是 55 那套 kind 集群的
实际取值，每条都在 2026-09-29 实测过，用于在别处照着复制。

**凭据不在这里。** 密码一律用下面给出的命令现取，不要抄进任何文件或聊天记录。

## 拓扑前提

节点容器 IP `172.20.0.2`（`kubectl get node -o wide` 的 INTERNAL-IP）。

宿主上**只映射了 6443**：

```console
$ docker port agent-sandbox-control-plane
6443/tcp -> 127.0.0.1:32999
```

所以全部 NodePort 只在 55 上经 `172.20.0.2` 可达，宿主 `10.10.205.55` 上没有监听。
本机 `ssh -L` 必须打到 `172.20.0.2`。实测：

| 端点 | 结果 |
| --- | --- |
| `http://172.20.0.2:30081/workspace/` | 200，前端 |
| `http://172.20.0.2:30080/` | 400，Edge 活着但没有匹配的 Host |
| `https://172.20.0.2:30443/` | 500，Edge TLS 活着 |

现有 NodePort：

| Service | 端口 |
| --- | --- |
| `codesphere/codesphere-frontend` | 80 → 30081 |
| `sandbox/sandbox-edge` | 80 → 30080，443 → 30443 |

## 一条隧道全带上

本机终端，保持开着：

```sh
ssh -N \
  -L 3000:127.0.0.1:13000 \
  -L 127.0.0.1:18081:172.20.0.2:30081 \
  -L 127.0.0.1:18080:172.20.0.2:30080 \
  -L 127.0.0.1:18443:172.20.0.2:30443 \
  55
```

| 本机 | 到 | 是什么 |
| --- | --- | --- |
| `127.0.0.1:3000` | 55 的 `127.0.0.1:13000` | Grafana，经 55 上的 kubectl port-forward |
| `127.0.0.1:18081` | `172.20.0.2:30081` | codesphere 前端 |
| `127.0.0.1:18080` | `172.20.0.2:30080` | Edge http |
| `127.0.0.1:18443` | `172.20.0.2:30443` | Edge https，沙箱通配域名走这条 |

## Grafana

<http://127.0.0.1:3000/d/xsphere-sandbox-overview>，用户 `admin`，四块面板在 **xsphere**
文件夹。密码现取：

```sh
ssh 55 "kubectl -n monitoring get secret kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d"
```

隧道连不上，先确认 55 上那个转发还活着（实测在线，Grafana 13.2.1）：

```sh
ssh 55 'curl -sS http://127.0.0.1:13000/api/health'
```

没响应就在 55 上另起终端保持：

```sh
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 13000:80
```

报 `13000: address already in use` 说明已有转发占着，先查它是否健康，不要重复起。
Grafana 只经本机隧道访问，不对外暴露。

## codesphere 前端

<http://127.0.0.1:18081/workspace/>

## 沙箱通配域名（浏览器）

域名 `sandbox-edge.sandbox.svc.cluster.local`，没有真实 DNS 区域 ——
`<port>-<id>.<domain>` 由 `kube-system/coredns` 的一条 rewrite 解析。证书是自签通配
（`CN=*.sandbox-edge.sandbox.svc.cluster.local`，SAN 含通配与 apex，有效期至
2036-09-25）。

用一次性 profile 的 Chrome，把通配域名映到隧道，并只钉这一张证书的公钥：

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/sandbox-55-chrome \
  --host-resolver-rules="MAP *.sandbox-edge.sandbox.svc.cluster.local:443 127.0.0.1:18443, MAP *.sandbox-edge.sandbox.svc.cluster.local:80 127.0.0.1:18080" \
  --ignore-certificate-errors-spki-list=aM2AvbM0/c5rjARcbPUAbQ0p98bikzkMSv7DBnDkOfQ=
```

SPKI 钉只放过这一张证书，比 `--ignore-certificate-errors` 窄得多。`--user-data-dir`
必须是一次性目录，不要用日常 profile。换证书后重算：

```sh
ssh 55 "kubectl -n sandbox get secret sandbox-edge-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64"
```

## WS_PUBLIC_URL 要跟访问路径一致

这个值由后端下发给前端，**由浏览器去连**，所以必须是浏览器真正能到的地址。55 上现在是
`ws://10.10.205.55:30081/workspace/internal/ws/pi-daemon`，而宿主 30081 并无监听
（只映射了 6443）。如果页面能打开但实时会话连不上，就是这里 —— 改成上面隧道的入口：

```sh
ssh 55 "kubectl -n codesphere set env deploy/codesphere-backend \
  WS_PUBLIC_URL=ws://127.0.0.1:18081/workspace/internal/ws/pi-daemon"
```

会重启 backend（`strategy: Recreate`，PVC 不动）。隧道端口变了就要跟着改。

按 [bootstrap.md](bootstrap.md) 的通用写法这个键属于 `codesphere-env` ConfigMap；55 上
它仍是 Deployment 里的内联 env，所以在 55 改 ConfigMap 不生效，得用上面的 `set env`。

## 项目数据在哪

不在任何 PVC 上。沙箱的 workspace 卷（`/data`）和 backend 自己的 PVC 都是空的；项目与
用户状态在 MinIO 桶里（`codesphere/`、`users/` 两个前缀）。
`AGENTSPHERE_PROJECTS_BASE_DIR` 指的是沙箱内每次会话物化出来的工作目录，不是持久层 ——
复制这套环境时照抄现值即可，不要试图把它搬到 workspace 卷上。
