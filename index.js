/**
 * Host half of the system-pulse HUD.
 *
 * Sampled on demand: every GET /api/system-pulse/snapshot takes one reading.
 * Nothing runs while nobody looks — the long-lived probes are started by the
 * first request and are stopped after `idleStopMs` of silence.
 *
 *   GET /api/system-pulse/snapshot?window=60   one JSON snapshot + history
 *   GET /api/system-pulse/health               probe states, for debugging
 *
 * CPU and memory come from node:os. The platform-specific probes are:
 *
 *   Windows  nvidia-smi -l N                 one CSV line per N seconds
 *            powershell Get-Counter          one JSON line per N seconds
 *            LibreHardwareMonitor web server temperatures, fan, package power
 *   macOS    ioreg -c IOAccelerator          GPU utilisation + unified memory
 *            netstat -ibn                    cumulative per-interface counters
 *            vm_stat / sysctl                Activity-Monitor style memory + swap
 *   Linux    /proc/net/dev                  cumulative per-interface counters
 *
 * Temperatures, fan speed and package power need a privileged sensor source on
 * macOS (powermetrics or the SMC), so those fields stay null there and `health`
 * says why. GPU temperature, clock and power are likewise unavailable; the HUD
 * shows utilisation and unified-memory usage instead.
 *
 * Windows detail: typeperf was the obvious choice for PDH counters, but its
 * stdout is fully buffered when piped, so it delivers nothing until it exits.
 * A PowerShell loop with -Continuous pays the PDH setup once and then formats
 * each sample in single-digit milliseconds. Temperatures need
 * LibreHardwareMonitor's web server; without it those fields stay null and
 * `health` says why, while the same poll also supplies GPU load on machines
 * without nvidia-smi.
 */

import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = '/api/system-pulse'
const MIB = 1024 * 1024

const PLATFORM = process.platform
const IS_WIN32 = PLATFORM === 'win32'
const IS_DARWIN = PLATFORM === 'darwin'
const IS_LINUX = PLATFORM === 'linux'

const DEFAULTS = {
  intervalMs: 1000,
  gpuIntervalMs: 2000,
  netIntervalMs: 3000,
  lhmIntervalMs: 3000,
  idleStopMs: 20000,
  historySize: 180,
  lhmUrl: 'http://localhost:8085/data.json',
  /** A probe older than this is reported as stale instead of silently reused. */
  gpuStaleMs: 8000,
  netStaleMs: 12000,
  tempsStaleMs: 12000,
}

const NVIDIA_QUERY = [
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'fan.speed',
  'clocks.current.graphics',
].join(',')

/** Adapters that must not contribute to the machine-wide network rate. */
const ADAPTER_SKIP =
  'isatap|loopback|teredo|pseudo|vethernet|wan miniport|bluetooth|tap|tailscale|zerotier|hyper-v|virtualbox|vmware|wireguard|openvpn'

/**
 * macOS system tools, called by absolute path: a GUI-launched app gets the
 * launchd PATH, which may not include /usr/sbin when DSH was started from a
 * shell with a trimmed environment.
 */
const DARWIN_TOOLS = {
  ioreg: '/usr/sbin/ioreg',
  netstat: '/usr/sbin/netstat',
  sysctl: '/usr/sbin/sysctl',
  vmStat: '/usr/bin/vm_stat',
}

/** Same idea for the BSD interface names netstat reports on macOS. */
const DARWIN_IFACE_SKIP =
  /^(lo\d*|gif\d*|stf\d*|anpi\d*|awdl\d*|llw\d*|ap\d*|bridge\d*|utun\d*|ipsec\d*|ppp\d*|nan\d*|vmenet\d*|vmnet\d*|tap\d*|tun\d*)$/

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Same-origin document fetches carry no Origin header; reject cross-site reads. */
function sameOrigin(req, expected) {
  const origin = req.headers.origin
  if (!origin || !expected) return true
  return origin === expected
}

function num(value) {
  const n = Number.parseFloat(String(value).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** One-shot helper for the cheap macOS system tools (a few milliseconds each). */
function execText(file, args, timeout = 3000) {
  return execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 8 * MIB })
}

function readCpuTimes() {
  const cpus = os.cpus()
  return {
    list: cpus.map((cpu) => {
      const t = cpu.times
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }
    }),
    model: cpus[0]?.model?.trim() ?? 'CPU',
    threads: cpus.length,
    speedMHz: cpus[0]?.speed ?? 0,
  }
}

/** The network relay: one PowerShell process, one JSON line per sample. */
function netRelayScript(intervalSeconds) {
  const skip = ADAPTER_SKIP.replace(/'/g, "''")
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$cs = @('\\Network Interface(*)\\Bytes Received/sec','\\Network Interface(*)\\Bytes Sent/sec','\\Processor Information(_Total)\\% Processor Performance')",
    `Get-Counter -Counter $cs -Continuous -SampleInterval ${intervalSeconds} | ForEach-Object {`,
    '  $rx=0; $tx=0; $n=0; $perf=0',
    '  foreach($s in $_.CounterSamples){',
    "    if($s.Path -like '*processor performance'){ $perf = [math]::Round($s.CookedValue, 1); continue }",
    `    if($s.InstanceName -match '${skip}'){ continue }`,
    "    if($s.Path -like '*bytes received/sec'){ $rx += $s.CookedValue } else { $tx += $s.CookedValue }",
    '    $n++',
    '  }',
    "  '{\"rx\":' + [math]::Round($rx) + ',\"tx\":' + [math]::Round($tx) + ',\"n\":' + $n + ',\"perf\":' + $perf + '}'",
    '}',
  ].join('\n')
}

/**
 * vm_stat pages. macOS' "Memory Used" (Activity Monitor) is
 * App Memory (anonymous − purgeable) + Wired + Compressed, so the page
 * classes are combined that way instead of total − free, which counts every
 * cached page and reads close to 100 % on a healthy Mac.
 */
function parseVmStat(text) {
  const pageSize = Number.parseInt(text.match(/page size of (\d+)/)?.[1] ?? '', 10)
  if (!pageSize) return null
  const pages = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm'))
    return match ? Number.parseInt(match[1], 10) : null
  }
  const anonymous = pages('Anonymous pages')
  const wired = pages('Pages wired down')
  const compressor = pages('Pages occupied by compressor')
  if (anonymous == null || wired == null || compressor == null) return null
  const purgeable = pages('Pages purgeable') ?? 0
  return { usedBytes: Math.max(0, anonymous - purgeable + wired + compressor) * pageSize }
}

/** `total = 7168.00M used = 6484.62M free = 683.38M (encrypted)` */
function parseSwapUsage(text) {
  const size = (match) => (match ? Number.parseFloat(match[1]) * (match[2] === 'G' ? 1024 ** 3 : MIB) : null)
  return {
    used: size(text.match(/used = ([\d.]+)([MG])/)),
    total: size(text.match(/total = ([\d.]+)([MG])/)),
  }
}

/**
 * netstat -ibn lists every address of every interface; only the link-layer
 * row (`<Link#N>`) carries the counters, and using it once per interface keeps
 * the totals from being double counted. Loopback, tunnels and wireless side
 * channels are skipped so the numbers match what the user thinks of as their
 * network connection.
 */
function parseNetstat(text) {
  const totals = new Map()
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 10 || !parts[2]?.startsWith('<Link#')) continue
    const name = parts[0].replace(/\*$/, '')
    if (DARWIN_IFACE_SKIP.test(name)) continue
    const rx = Number(parts[6])
    const tx = Number(parts[9])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    totals.set(name, { rx, tx })
  }
  return totals
}

/**
 * IOAccelerator exposes the driver's PerformanceStatistics on both Apple
 * Silicon (AGX) and Intel/AMD Macs. Apple GPUs share system memory, so
 * `In use system memory` is reported as the GPU working set and `memTotal`
 * stays null (there is no separate VRAM pool).
 */
function parseAccelerator(text) {
  const model = text.match(/"model" = "([^"]+)"/)?.[1]?.trim() || ''
  const cores = Number.parseInt(text.match(/"gpu-core-count" = (\d+)/)?.[1] ?? '', 10)
  let best = null
  const blockRe = /"PerformanceStatistics" = \{([^}]*)\}/g
  let block
  while ((block = blockRe.exec(text)) !== null) {
    const stats = {}
    const pairRe = /"([^"]+)"\s*=\s*"?([^",}]*)"?/g
    let pair
    while ((pair = pairRe.exec(block[1])) !== null) {
      const value = Number.parseFloat(pair[2])
      if (Number.isFinite(value)) stats[pair[1].trim()] = value
    }
    const usage = Number.isFinite(stats['Device Utilization %'])
      ? stats['Device Utilization %']
      : stats['Renderer Utilization %']
    if (!Number.isFinite(usage)) continue
    const memUsed = Number.isFinite(stats['In use system memory']) ? stats['In use system memory'] : null
    if (!best || usage > best.usage || (usage === best.usage && (memUsed ?? 0) > (best.memUsed ?? 0))) {
      best = { usage, memUsed }
    }
  }
  if (!best) return null
  const apple = /^Apple/i.test(model)
  return {
    vendor: apple ? 'apple' : 'ioreg',
    name: model || 'GPU',
    cores: Number.isFinite(cores) ? cores : null,
    usage: clamp01(best.usage / 100),
    memUsed: best.memUsed,
    memTotal: null,
    shared: apple,
    tempC: null,
    powerW: null,
    fanPct: null,
    clockMHz: null,
  }
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  let origin = ''
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    origin = ''
  }

  const state = {
    prevCpu: readCpuTimes(),
    lastCpu: null,
    gpu: null,
    gpuAt: 0,
    net: null,
    netAt: 0,
    temps: null,
    tempsAt: 0,
    probes: {
      gpu: { state: 'idle', reason: null },
      net: { state: 'idle', reason: null },
      mem: { state: 'idle', reason: null },
      temps: { state: 'idle', reason: null },
    },
    history: [],
    snapshot: null,
    lastSampleAt: 0,
    prevNetDev: null,
    prevNetAt: 0,
    /** macOS: previous per-interface netstat counters and when they were read. */
    prevNetIfaces: null,
    netSampledAt: 0,
    /** macOS: cached vm_stat reading (the command costs ~5 ms). */
    mem: null,
    memAt: 0,
    memLastGoodAt: 0,
    swap: null,
    swapAt: 0,
    /** `% Processor Performance` from the network relay, relative to nominal. */
    perfPct: null,
  }

  /** Physical core count; `os.cpus()` only reports logical processors. */
  let physicalCores = null
  let coreSplit = null
  let coresProbeStarted = false
  let coresChild = null
  const nominalMHz = os.cpus()[0]?.speed ?? 0

  let active = false
  let lastSeen = 0
  let gpuChild = null
  let gpuTimer = null
  let netChild = null
  let lhmTimer = null
  let lhmBackoffUntil = 0

  function setProbe(name, next) {
    state.probes[name] = next
  }

  function kill(child) {
    if (!child) return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  // ---------------------------------------------------------------- sampling

  function sampleCpu() {
    const next = readCpuTimes()
    const prev = state.prevCpu
    const perCore = []
    let idleSum = 0
    let totalSum = 0
    for (let i = 0; i < next.list.length; i += 1) {
      const before = prev.list[i]
      const after = next.list[i]
      if (!before) {
        perCore.push(0)
        continue
      }
      const idle = after.idle - before.idle
      const total = after.total - before.total
      if (total <= 0) {
        perCore.push(0)
        continue
      }
      idleSum += idle
      totalSum += total
      perCore.push(clamp01(1 - idle / total))
    }
    const usage = totalSum > 0 ? clamp01(1 - idleSum / totalSum) : 0
    state.prevCpu = next
    // A reading taken immediately after the HUD wakes up can span only a few
    // milliseconds, where the per-tick rounding dominates and every core
    // looks saturated. Reuse the previous value instead of flashing 100 %.
    const minTotal = (next.list.length * Math.max(250, cfg.intervalMs)) / 2
    if (totalSum < minTotal) {
      if (state.lastCpu) return state.lastCpu
      state.lastCpu = {
        usage: 0,
        perCore: next.list.map(() => 0),
        model: next.model,
        threads: next.threads,
        speedMHz: next.speedMHz,
      }
      return state.lastCpu
    }
    state.lastCpu = {
      usage,
      perCore,
      model: next.model,
      threads: next.threads,
      speedMHz: next.speedMHz,
    }
    return state.lastCpu
  }

  function freshGpu(now) {
    if (!state.gpu) return { value: null, health: state.probes.gpu }
    const stale = now - state.gpuAt > cfg.gpuStaleMs
    return {
      value: state.gpu,
      health: stale ? { state: 'stale', reason: 'GPU 数据停止更新' } : state.probes.gpu,
    }
  }

  function freshNet(now) {
    if (!state.net) return { value: null, health: state.probes.net }
    const stale = now - state.netAt > cfg.netStaleMs
    return {
      value: state.net,
      health: stale ? { state: 'stale', reason: '网络计数停止更新' } : state.probes.net,
    }
  }

  function freshTemps(now) {
    if (!state.temps) return { value: null, health: state.probes.temps }
    const stale = now - state.tempsAt > cfg.tempsStaleMs
    return {
      value: state.temps,
      health: stale ? { state: 'stale', reason: '温度数据停止更新' } : state.probes.temps,
    }
  }

  /** macOS memory: vm_stat, Activity Monitor semantics, refreshed at ~1 Hz. */
  function macMemory(now) {
    if (now - state.memAt < 800) return state.mem
    state.memAt = now
    try {
      state.mem = parseVmStat(execText(DARWIN_TOOLS.vmStat, []))
      if (!state.memLastGoodAt) state.memLastGoodAt = now
      setProbe('mem', { state: 'ok', reason: null })
    } catch (error) {
      // Keep the last good reading: a single failed exec must not blank the
      // row, and os.freemem() is not a usable substitute here (see below).
      setProbe('mem', {
        state: state.mem ? 'stale' : 'unavailable',
        reason: state.mem
          ? 'vm_stat 读取失败，显示上一次读数'
          : `无法读取 vm_stat：${String(error?.message ?? error)}`,
      })
    }
    return state.mem
  }

  /** Swap is slow-moving; one sysctl per five seconds is plenty. */
  function macSwap(now) {
    if (now - state.swapAt < 5000) return
    state.swapAt = now
    try {
      state.swap = parseSwapUsage(execText(DARWIN_TOOLS.sysctl, ['-n', 'vm.swapusage']))
    } catch {
      /* keep the previous reading */
    }
  }

  function readMemory(now) {
    const total = os.totalmem()
    if (IS_DARWIN) {
      macSwap(now)
      const mac = macMemory(now)
      if (mac) {
        const used = Math.min(total, mac.usedBytes)
        return {
          total,
          used,
          usage: total > 0 ? used / total : 0,
          source: 'vm_stat',
          swapUsed: state.swap?.used ?? null,
          swapTotal: state.swap?.total ?? null,
        }
      }
      // Never fall back to os.freemem() on macOS: it counts free pages only, so
      // the very first failed vm_stat would paint 99% memory in use.
      return null
    }
    const free = os.freemem()
    return { total, used: total - free, usage: total > 0 ? (total - free) / total : 0 }
  }

  /** Linux fallback: /proc/net/dev is cheaper than any child process. */
  function sampleNetProc(now) {
    if (state.prevNetDev == null) {
      try {
        const totals = readProcNetDev()
        state.prevNetDev = totals
        state.prevNetAt = now
        setProbe('net', { state: 'sampling', reason: '正在建立网络基线' })
      } catch {
        setProbe('net', { state: 'unavailable', reason: '无法读取 /proc/net/dev' })
      }
      return
    }
    const elapsed = (now - state.prevNetAt) / 1000
    if (elapsed <= 0) return
    let current
    try {
      current = readProcNetDev()
    } catch (error) {
      setProbe('net', { state: 'unavailable', reason: `无法读取 /proc/net/dev：${error?.message ?? error}` })
      return
    }
    state.net = {
      rxBps: Math.max(0, (current.rx - state.prevNetDev.rx) / elapsed),
      txBps: Math.max(0, (current.tx - state.prevNetDev.tx) / elapsed),
    }
    state.netAt = now
    state.prevNetDev = current
    state.prevNetAt = now
    // Without this the probe stays at "sampling" even though rates are live,
    // because nothing else ever reports a successful Linux read.
    setProbe('net', { state: 'ok', reason: null })
  }

  function readProcNetDev() {
    const text = readFileSync('/proc/net/dev', 'utf8')
    let rx = 0
    let tx = 0
    for (const line of text.split('\n')) {
      const index = line.indexOf(':')
      if (index < 0) continue
      const iface = line.slice(0, index).trim()
      if (iface === 'lo' || /^(veth|docker|br-|tun|tap)/.test(iface)) continue
      const fields = line
        .slice(index + 1)
        .trim()
        .split(/\s+/)
        .map(Number)
      if (fields.length < 9) continue
      rx += fields[0] || 0
      tx += fields[8] || 0
    }
    return { rx, tx }
  }

  /** macOS network: diff the cumulative netstat counters, per interface. */
  function sampleNetDarwin(now) {
    if (state.netSampledAt && now - state.netSampledAt < Math.max(1000, cfg.netIntervalMs)) return
    let current
    try {
      current = parseNetstat(execText(DARWIN_TOOLS.netstat, ['-ibn']))
    } catch (error) {
      setProbe('net', { state: 'unavailable', reason: `netstat 读取失败：${error?.message ?? error}` })
      return
    }
    if (!current.size) {
      setProbe('net', { state: 'unavailable', reason: 'netstat 没有返回接口计数器' })
      return
    }
    const previous = state.prevNetIfaces
    const previousAt = state.netSampledAt
    state.prevNetIfaces = current
    state.netSampledAt = now
    if (!previous) {
      setProbe('net', { state: 'sampling', reason: '正在建立网络基线' })
      return
    }
    const elapsed = (now - previousAt) / 1000
    if (elapsed <= 0) return
    let rx = 0
    let tx = 0
    for (const [name, counters] of current) {
      const before = previous.get(name)
      if (!before) continue
      // Interfaces that reset or wrap must not produce a negative burst.
      rx += Math.max(0, counters.rx - before.rx)
      tx += Math.max(0, counters.tx - before.tx)
    }
    state.net = { rxBps: rx / elapsed, txBps: tx / elapsed }
    state.netAt = now
    setProbe('net', { state: 'ok', reason: null })
  }

  function sample() {
    const now = Date.now()
    const cpu = sampleCpu()
    const mem = readMemory(now)
    const gpu = freshGpu(now)
    const net = freshNet(now)
    const temps = freshTemps(now)

    const point = {
      t: now,
      c: Math.round(cpu.usage * 1000) / 1000,
      m: mem ? Math.round(mem.usage * 1000) / 1000 : null,
      g: gpu.value && Number.isFinite(gpu.value.usage) ? Math.round(gpu.value.usage * 1000) / 1000 : null,
      r: net.value ? Math.round(net.value.rxBps) : null,
      s: net.value ? Math.round(net.value.txBps) : null,
    }
    state.history.push(point)
    while (state.history.length > cfg.historySize) state.history.shift()

    state.snapshot = {
      t: now,
      host: {
        name: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptimeMs: Math.round(os.uptime() * 1000),
      },
      cpu: {
        usage: point.c,
        perCore: cpu.perCore.map((v) => Math.round(v * 1000) / 1000),
        model: cpu.model,
        cores: physicalCores,
        threads: cpu.threads,
        perfCores: coreSplit?.perf ?? null,
        effCores: coreSplit?.eff ?? null,
        speedMHz: cpu.speedMHz,
        clockMHz:
          state.perfPct != null && nominalMHz > 0
            ? Math.round((nominalMHz * state.perfPct) / 100)
            : null,
      },
      mem,
      gpu: gpu.value,
      net: net.value,
      temps: temps.value,
      health: { gpu: gpu.health, net: net.health, mem: state.probes.mem, temps: temps.health },
      intervalMs: cfg.intervalMs,
    }
    state.lastSampleAt = now
    return state.snapshot
  }

  // ------------------------------------------------------------------ probes

  function startGpu() {
    if (gpuChild) return
    let child
    try {
      child = spawn(
        'nvidia-smi',
        [
          `--query-gpu=${NVIDIA_QUERY}`,
          '--format=csv,noheader,nounits',
          '-l',
          String(Math.max(1, Math.round(cfg.gpuIntervalMs / 1000))),
        ],
        { windowsHide: true },
      )
    } catch (error) {
      setProbe('gpu', { state: 'unavailable', reason: String(error?.message ?? error) })
      return
    }
    gpuChild = child
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) parseGpuLine(line)
        index = buffer.indexOf('\n')
      }
      if (buffer.length > 8192) buffer = ''
    })
    child.on('error', (error) => {
      gpuChild = null
      setProbe('gpu', {
        state: 'unavailable',
        reason:
          error?.code === 'ENOENT'
            ? '未找到 nvidia-smi（非 NVIDIA 显卡需要 LibreHardwareMonitor）'
            : String(error?.message ?? error),
      })
    })
    child.on('exit', (code) => {
      if (gpuChild !== child) return
      gpuChild = null
      state.gpu = null
      setProbe('gpu', { state: 'unavailable', reason: `nvidia-smi 退出（code ${code}）` })
    })
  }

  function parseGpuLine(line) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 8) return
    const usage = num(parts[1])
    const memUsed = num(parts[2])
    const memTotal = num(parts[3])
    state.gpu = {
      vendor: 'nvidia',
      name: parts[0] || 'GPU',
      usage: usage == null ? null : clamp01(usage / 100),
      memUsed: memUsed == null ? null : Math.round(memUsed * MIB),
      memTotal: memTotal == null ? null : Math.round(memTotal * MIB),
      tempC: num(parts[4]),
      powerW: num(parts[5]),
      fanPct: num(parts[6]),
      clockMHz: num(parts[7]),
    }
    state.gpuAt = Date.now()
    setProbe('gpu', { state: 'ok', reason: null })
  }

  /**
   * macOS GPU: ioreg is a one-shot read and cheap enough to poll. Apple
   * Silicon has no nvidia-smi and no unprivileged temperature source, so the
   * reading is utilisation plus the unified-memory working set.
   */
  function startGpuDarwin() {
    if (gpuTimer) return
    const poll = () => {
      let text
      try {
        text = execText(DARWIN_TOOLS.ioreg, ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])
      } catch (error) {
        setProbe('gpu', { state: 'unavailable', reason: `ioreg 读取失败：${error?.message ?? error}` })
        return
      }
      const gpu = parseAccelerator(text)
      if (!gpu) {
        setProbe('gpu', { state: 'unavailable', reason: 'IORegistry 中没有可用的 GPU 统计（IOAccelerator）' })
        return
      }
      state.gpu = gpu
      state.gpuAt = Date.now()
      setProbe('gpu', { state: 'ok', reason: null })
    }
    poll()
    gpuTimer = setInterval(poll, Math.max(500, cfg.gpuIntervalMs))
    gpuTimer.unref?.()
  }

  function startNet() {
    if (IS_DARWIN) {
      sampleNetDarwin(Date.now())
      return
    }
    if (netChild) return
    if (!IS_WIN32) {
      if (IS_LINUX) {
        sampleNetProc(Date.now())
      } else {
        setProbe('net', { state: 'unavailable', reason: `当前平台（${PLATFORM}）暂不支持网络速率` })
      }
      return
    }
    // The relay prints its first line only after one sample interval, so say
    // "sampling" rather than "unavailable" until a reading has arrived.
    setProbe('net', { state: 'sampling', reason: '正在启动网络计数器' })
    const interval = Math.max(1, Math.round(cfg.netIntervalMs / 1000))
    let child
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', netRelayScript(interval)], {
        windowsHide: true,
      })
    } catch (error) {
      setProbe('net', { state: 'unavailable', reason: String(error?.message ?? error) })
      return
    }
    netChild = child
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith('{')) parseNetLine(line)
        index = buffer.indexOf('\n')
      }
      if (buffer.length > 16384) buffer = ''
    })
    child.on('error', (error) => {
      netChild = null
      setProbe('net', {
        state: 'unavailable',
        reason: error?.code === 'ENOENT' ? '未找到 powershell' : String(error?.message ?? error),
      })
    })
    child.on('exit', (code) => {
      if (netChild !== child) return
      netChild = null
      state.net = null
      setProbe('net', { state: 'unavailable', reason: `网络计数器退出（code ${code}）` })
    })
  }

  function parseNetLine(line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    const rx = num(payload.rx)
    const tx = num(payload.tx)
    if (rx == null || tx == null) return
    if (!payload.n) {
      setProbe('net', { state: 'unavailable', reason: '没有可用的网络适配器计数器' })
      return
    }
    state.net = { rxBps: Math.max(0, rx), txBps: Math.max(0, tx) }
    state.netAt = Date.now()
    const perf = num(payload.perf)
    if (perf != null && perf > 0) state.perfPct = perf
    setProbe('net', { state: 'ok', reason: null })
  }

  function startLhm() {
    if (lhmTimer) return
    const poll = async () => {
      if (Date.now() < lhmBackoffUntil) return
      let root
      try {
        const response = await fetch(cfg.lhmUrl, {
          signal: AbortSignal.timeout(1500),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        root = await response.json()
      } catch {
        lhmBackoffUntil = Date.now() + 30000
        setProbe('temps', {
          state: 'unavailable',
          reason: '未检测到 LibreHardwareMonitor 的 Web Server（Options → Remote Web Server）',
        })
        return
      }
      // Flatten the sensor tree. Leaves carry a SensorId such as
      // `/amdcpu/0/temperature/2`, which identifies the sensor group without
      // depending on a vendor-specific display name.
      const leaves = []
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        const value = typeof node.Value === 'string' ? node.Value.trim() : ''
        if (value && value !== '-') {
          leaves.push({
            id: String(node.SensorId ?? node.id ?? ''),
            text: String(node.Text ?? ''),
            value,
          })
        }
        if (Array.isArray(node.Children)) for (const child of node.Children) walk(child)
      }
      walk(root)

      const isCpuSensor = (leaf) => /^\/(amdcpu|intelcpu)\//.test(leaf.id)
      const isGpuSensor = (leaf) => /^\/gpu-[a-z0-9]+\//.test(leaf.id)

      // CPU package temperature: Tctl/Tdie first, then a "Package" sensor.
      const tempRank = (leaf) => {
        if (/tctl/i.test(leaf.text)) return 3
        if (/package/i.test(leaf.text)) return 2
        if (/ccd|core/i.test(leaf.text)) return 1
        return 0
      }
      const cpuTemp =
        leaves
          .filter((leaf) => isCpuSensor(leaf) && /\/temperature\//.test(leaf.id))
          .sort((a, b) => tempRank(b) - tempRank(a))[0] ?? null
      const cpuPower =
        leaves
          .filter((leaf) => isCpuSensor(leaf) && /\/power\//.test(leaf.id))
          .sort((a, b) => Number(/package/i.test(b.text)) - Number(/package/i.test(a.text)))[0] ?? null
      const boardFans = leaves
        .filter((leaf) => /\/fan\/\d+$/.test(leaf.id) && !isGpuSensor(leaf) && /rpm/i.test(leaf.value))
        .map((leaf) => num(leaf.value))
        .filter((value) => value != null)
      const next = {
        cpuC: cpuTemp ? num(cpuTemp.value) : null,
        fanRpm: boardFans.length ? Math.max(...boardFans) : null,
        cpuPowerW: cpuPower ? num(cpuPower.value) : null,
        source: 'LibreHardwareMonitor',
      }
      if (next.cpuC == null && next.fanRpm == null && next.cpuPowerW == null) {
        setProbe('temps', { state: 'unavailable', reason: 'LibreHardwareMonitor 未暴露温度传感器' })
      } else {
        state.temps = next
        state.tempsAt = Date.now()
        setProbe('temps', { state: 'ok', reason: null })
      }

      // GPU fallback for machines without nvidia-smi.
      if (!state.gpu || state.gpu.vendor === 'lhm') {
        const findGpu = (regex) => leaves.find((leaf) => isGpuSensor(leaf) && regex.test(leaf.id))
        const load = findGpu(/\/load\/0$/)
        const gpuTemp = findGpu(/\/temperature\/0$/)
        const memUsed = leaves.find((leaf) => isGpuSensor(leaf) && /dedicated.*used|memory used/i.test(leaf.text))
        const memTotal = leaves.find((leaf) => isGpuSensor(leaf) && /memory total/i.test(leaf.text))
        if (load) {
          state.gpu = {
            vendor: 'lhm',
            name: 'GPU',
            usage: clamp01((num(load.value) ?? 0) / 100),
            memUsed: memUsed ? Math.round((num(memUsed.value) ?? 0) * MIB) : null,
            memTotal: memTotal ? Math.round((num(memTotal.value) ?? 0) * MIB) : null,
            tempC: gpuTemp ? num(gpuTemp.value) : null,
            powerW: null,
            fanPct: null,
            clockMHz: null,
          }
          state.gpuAt = Date.now()
          setProbe('gpu', { state: 'ok', reason: null })
        }
      }
    }
    poll()
    lhmTimer = setInterval(poll, cfg.lhmIntervalMs)
    lhmTimer.unref?.()
  }

  function probeCores() {
    if (coresProbeStarted || physicalCores != null) return
    if (IS_DARWIN) {
      // Both sysctl calls together cost a few milliseconds, so they run
      // synchronously and the very first snapshot already knows the layout.
      coresProbeStarted = true
      try {
        const count = Number.parseInt(execText(DARWIN_TOOLS.sysctl, ['-n', 'hw.physicalcpu']).trim(), 10)
        if (Number.isFinite(count) && count > 0 && count <= 2048) physicalCores = count
        // Apple Silicon splits its cores into performance and efficiency
        // clusters; Intel Macs do not expose the perflevel keys.
        const out = execText(DARWIN_TOOLS.sysctl, [
          '-n',
          'hw.perflevel0.physicalcpu',
          'hw.perflevel1.physicalcpu',
        ])
        const [perf, eff] = out.trim().split(/\s+/).map(Number)
        if (Number.isFinite(perf) && Number.isFinite(eff)) coreSplit = { perf, eff }
      } catch {
        coresProbeStarted = false
      }
      return
    }
    if (!IS_WIN32) return
    coresProbeStarted = true
    let child
    try {
      child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[int](Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
        ],
        { windowsHide: true },
      )
    } catch {
      coresProbeStarted = false
      return
    }
    coresChild = child
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (out.length > 4096) out = ''
    })
    child.on('error', () => {
      coresProbeStarted = false
    })
    child.on('exit', () => {
      coresChild = null
      const count = Number.parseInt(out.trim(), 10)
      if (Number.isFinite(count) && count > 0 && count <= 2048) {
        physicalCores = count
      } else {
        coresProbeStarted = false
      }
    })
  }

  function start() {
    if (active) return
    active = true
    probeCores()
    if (IS_DARWIN) startGpuDarwin()
    else startGpu()
    startNet()
    if (IS_DARWIN) {
      // SMC and powermetrics both require root; there is no unprivileged
      // temperature API on macOS, so say so instead of inventing numbers.
      setProbe('temps', {
        state: 'unavailable',
        reason: 'macOS 不向非特权进程提供温度、风扇与封装功耗（需要 root 的 powermetrics / SMC）',
      })
    } else {
      startLhm()
    }
  }

  function stop() {
    active = false
    kill(gpuChild)
    kill(netChild)
    kill(coresChild)
    gpuChild = null
    netChild = null
    coresChild = null
    if (gpuTimer) clearInterval(gpuTimer)
    if (lhmTimer) clearInterval(lhmTimer)
    gpuTimer = null
    lhmTimer = null
    // Do not average the next reading over the idle gap: drop the baselines
    // and the last reading so the HUD shows "sampling…" on resume instead of
    // a rate averaged over minutes of silence.
    state.prevNetIfaces = null
    state.netSampledAt = 0
    state.prevNetDev = null
    state.prevNetAt = 0
    state.net = null
    state.netAt = 0
  }

  function touch() {
    lastSeen = Date.now()
    if (!active) start()
  }

  ctx.effect(() => {
    const guard = setInterval(() => {
      if (active && Date.now() - lastSeen > cfg.idleStopMs) stop()
    }, 3000)
    guard.unref?.()
    return () => {
      clearInterval(guard)
      stop()
    }
  })

  // -------------------------------------------------------------------- route

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (!sameOrigin(req, origin)) return json(res, 403, { ok: false, error: 'cross-origin request refused' })
        const url = new URL(req.url, origin || 'http://127.0.0.1')
        const action = url.pathname.slice(BASE.length).replace(/^\/+/, '')
        try {
          if (action === '' || action === 'snapshot') {
            touch()
            const now = Date.now()
            if (action === 'snapshot') {
              // Throttled per call, not gated on state.net: gating there froze
              // the rate after the very first successful sample.
              if (IS_LINUX) sampleNetProc(now)
              if (IS_DARWIN) sampleNetDarwin(now)
            }
            if (!state.snapshot || now - state.lastSampleAt >= cfg.intervalMs) sample()
            const requested = Number.parseInt(url.searchParams.get('window') ?? '60', 10)
            const window = Math.min(cfg.historySize, Math.max(0, Number.isFinite(requested) ? requested : 60))
            return json(res, 200, {
              ...state.snapshot,
              history: window > 0 ? state.history.slice(-window) : [],
            })
          }
          if (action === 'health') {
            return json(res, 200, { ok: true, probes: state.probes, active })
          }
          return json(res, 404, { ok: false, error: `unknown action: ${action}` })
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )
}