# System Pulse · 系统脉搏

一块浮在 DSH Web 界面右上角的实时系统监控卡片。拖标题栏可移动、位置会记住；点 `–` 收成一个显示 CPU 占用的小圆环，点圆环再展开。

![系统脉搏浮窗：处理器 31% · 53°C · 70W，显卡 8% · 49°C · 70W，内存 63%](docs/preview.png)

```
┌──────────────────────────────┐
│ ● 系统脉搏                 –  │
│ 处理器  41%  ▬▬▬  64°C · 107W│
│ ▁▂▁▃▂▅▃▂▁▂▁▃▂▅▃▂              │  ← 16 个逻辑核，瞬时占用
│      ╱╲___╱╲__╱╲__            │  ← 最近 60 秒 CPU 趋势
│ 显卡    12%  ▬▬   48°C · 35W  │
│ 内存    56%  ▬▬▬  18.0/32.0G  │
│ 网络    ↓ 1.0 MB/s ↑ 93 KB/s  │
│ YaeSakura · ↑ 2h 14m · 1s     │
└──────────────────────────────┘
```

## 功能

| 行 | 内容 | 数据来源 |
|---|---|---|
| 处理器 | 总占用、逐核占用、60 秒趋势、封装温度、封装功耗、风扇 | `os.cpus()` 差分；温度用 LibreHardwareMonitor，macOS 不提供 |
| 显卡 | 利用率、显存/统一内存、温度、功耗、频率 | `nvidia-smi`；macOS 走 `ioreg -c IOAccelerator` |
| 内存 | 已用/总量、占用率、交换空间 | `os.totalmem`；macOS 走 `vm_stat` + `sysctl vm.swapusage` |
| 网络 | 上下行实时速率 | Windows `Get-Counter`；macOS `netstat -ibn`；Linux `/proc/net/dev` |

设计上的几点取舍：

- **1 Hz 轮询**而不是 SSE：一个 `GET /api/system-pulse/snapshot` 就能拿全量数据，够快也够简单。
- **服务端算好百分比**，客户端只画。历史环形缓冲在服务端，刷新页面立刻有趋势线。
- **空闲自动停机**：面板发起最后一次请求 20 秒后，`nvidia-smi` 与 PowerShell 子进程一起被杀掉，插件回到零开销。
- **拿不到的指标就显示 `—` 并说明原因**，不猜数字。

## 安装

```text
plugin_manager  install_bundle  target = git+https://github.com/Zmh-Freedom/dsh-plugin-system-pulse.git
```

想固定在某个版本上，加上 tag：

```text
plugin_manager  install_bundle  target = git+https://github.com/Zmh-Freedom/dsh-plugin-system-pulse.git#v0.2.0
```

也可以把仓库克隆或解压到本地任意目录，用路径安装（适合需要改代码的场合）：

```text
plugin_manager  install_bundle  target = /path/to/dsh-plugin-system-pulse
```

装好后重启 DSH（Host 半体需要重新加载），刷新页面即可看到浮窗。

> 安装过程会用到 `git`，请确保本机可用；插件本身零依赖、无构建步骤。

## 配置

在 bundle 补丁里覆盖 `config`，例如：

```yaml
- insert:
    - id: system-pulse
      name: 'dsh-plugin-system-pulse'
      config:
        intervalMs: 2000
        idleStopMs: 60000
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `intervalMs` | `1000` | 客户端轮询间隔（毫秒） |
| `gpuIntervalMs` | `2000` | `nvidia-smi` 采样间隔 |
| `netIntervalMs` | `3000` | 网络计数器采样间隔 |
| `lhmIntervalMs` | `3000` | 温度探测间隔 |
| `idleStopMs` | `20000` | 无请求多久后停掉所有子进程 |
| `historySize` | `180` | 服务端保留的历史点数 |
| `lhmUrl` | `http://localhost:8085/data.json` | LibreHardwareMonitor 的 Web Server 地址 |
| `gpuStaleMs` / `netStaleMs` / `tempsStaleMs` | `8000` / `12000` / `12000` | 超过此时长未更新即标记为 stale |

## Windows：CPU 温度需要一个传感器源

Windows 没有向用户态暴露 CPU 温度的接口（WMI 温区、PDH 温区计数器、`Win32_TemperatureProbe` 在多数台式机上都是空的）。读取 SMU/SuperIO 需要 ring0，所以本插件复用 [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) 的已签名驱动与其 HTTP 接口：

1. 安装并运行 LibreHardwareMonitor（需要管理员权限）；
2. 打开 `Options → Remote Web Server`（默认端口 8085）；
3. 插件会在 30 秒内自动接上，无需重启。

不装也能用：卡片照常显示占用、频率、内存、显卡与网络，只是温度/功耗/风扇显示 `—`，悬停会说明原因。

## 平台支持

| 功能 | Windows | Linux | macOS |
|---|---|---|---|
| CPU / 内存 | ✅ | ✅ | ✅ |
| 网络速率 | ✅ | ✅（`/proc/net/dev`） | ✅（`netstat -ibn`） |
| GPU | ✅ NVIDIA（或 LHM） | ✅ NVIDIA | ✅ Apple Silicon / Intel 核显（`ioreg`） |
| CPU 温度 / 风扇 / 功耗 | ✅ 需 LHM | — | —（需 root 的 powermetrics / SMC） |
| 换页 / 交换空间 | — | — | ✅ |

### macOS

- **内存口径**：`os.freemem()` 在 macOS 上只统计 free pages，会把一台健康机器的占用显示成 99%。插件改用 `vm_stat`，按活动监视器的算法计算：`已用 =（匿名页 − 可清除页 + 联动页 + 压缩页）× 页大小`，同时用 `sysctl vm.swapusage` 读出交换空间。
- **GPU**：Apple Silicon 没有 `nvidia-smi`，统一内存也没有独立的显存池，因此改为轮询 `ioreg -c IOAccelerator`，取 `Device Utilization %` 作为利用率、`In use system memory` 作为 GPU 工作集，`GPU 核心数` 从 `gpu-core-count` 读出。
- **核心结构**：`hw.perflevel0/1.physicalcpu` 给出性能核与能效核数量，卡片显示成 `4P+6E` 而不是容易误解的 `10C/10T`。
- **温度/风扇/功耗**：macOS 只对 root 开放这些传感器（`powermetrics` 与 SMC），非特权进程拿不到任何可靠读数，所以这三项显示 `—` 并说明原因，不会猜测数值。

## 已知限制

- 主板风扇通道没接转速计时会读到 `0 RPM`，此时行内不显示风扇，原始值在悬停提示里。
- 显卡在 Windows/Linux 上只覆盖 NVIDIA（`nvidia-smi`）；其它显卡在装了 LibreHardwareMonitor 时会用它兜底。
- HTTP 路由只接受同源请求（校验 `Origin`），但仍然请只在可信的本机环境启用。

## 许可

MIT