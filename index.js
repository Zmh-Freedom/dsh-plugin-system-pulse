/**
 * Host half of the system-pulse HUD.
 *
 * Sampled on demand: every GET /api/system-pulse/snapshot takes one reading.
 * Nothing runs while nobody looks — the GPU and network probes are long-lived
 * child processes that start with the first request and are killed after
 * `idleStopMs` of silence.
 *
 *   GET /api/system-pulse/snapshot?window=60   one JSON snapshot + history
 *   GET /api/system-pulse/health               probe states, for debugging
 *
 * Cheap values come from node:os. The expensive ones come from two helpers,
 * because spawning a shell per sample costs far more than the data is worth:
 *
 *   nvidia-smi ... -l N                      one CSV line per N seconds
 *   powershell Get-Counter -Continuous       one JSON line per N seconds
 *
 * typeperf was the obvious choice for PDH counters, but its stdout is fully
 * buffered when piped, so it delivers nothing until it exits. A PowerShell
 * loop with -Continuous pays the PDH setup once and then formats each sample
 * in single-digit milliseconds.
 *
 * Temperatures, fan and CPU package power need LibreHardwareMonitor's web
 * server. When it is absent those fields stay null and `health` says why; the
 * same poll also supplies GPU load on machines without nvidia-smi.
 */

import os from 'node:os'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const BASE = '/api/system-pulse'
const MIB = 1024 * 1024

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

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
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
      temps: { state: 'idle', reason: null },
    },
    history: [],
    snapshot: null,
    lastSampleAt: 0,
    prevNetDev: null,
    prevNetAt: 0,
    /** `% Processor Performance` from the network relay, relative to nominal. */
    perfPct: null,
  }

  /** Physical core count; `os.cpus()` only reports logical processors. */
  let physicalCores = null
  let coresProbeStarted = false
  let coresChild = null
  const nominalMHz = os.cpus()[0]?.speed ?? 0

  let active = false
  let lastSeen = 0
  let gpuChild = null
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

  /** Linux fallback: /proc/net/dev is cheaper than any child process. */
  function sampleNetProc(now) {
    if (state.prevNetDev == null) {
      try {
        const totals = readProcNetDev()
        state.prevNetDev = totals
        state.prevNetAt = now
        setProbe('net', { state: 'ok', reason: null })
      } catch {
        setProbe('net', { state: 'unavailable', reason: '无法读取 /proc/net/dev' })
      }
      return
    }
    const elapsed = (now - state.prevNetAt) / 1000
    if (elapsed <= 0) return
    const current = readProcNetDev()
    state.net = {
      rxBps: Math.max(0, (current.rx - state.prevNetDev.rx) / elapsed),
      txBps: Math.max(0, (current.tx - state.prevNetDev.tx) / elapsed),
    }
    state.netAt = now
    state.prevNetDev = current
    state.prevNetAt = now
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

  function sample() {
    const now = Date.now()
    const cpu = sampleCpu()
    const total = os.totalmem()
    const free = os.freemem()
    const mem = { total, used: total - free, usage: total > 0 ? (total - free) / total : 0 }
    const gpu = freshGpu(now)
    const net = freshNet(now)
    const temps = freshTemps(now)

    const point = {
      t: now,
      c: Math.round(cpu.usage * 1000) / 1000,
      m: Math.round(mem.usage * 1000) / 1000,
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
      health: { gpu: gpu.health, net: net.health, temps: temps.health },
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

  function startNet() {
    if (netChild) return
    if (process.platform !== 'win32') {
      if (process.platform === 'linux') {
        sampleNetProc(Date.now())
        setProbe('net', { state: state.net ? 'ok' : 'idle', reason: null })
      } else {
        setProbe('net', { state: 'unavailable', reason: `当前平台（${process.platform}）暂不支持网络速率` })
      }
      return
    }
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
    if (process.platform !== 'win32') return
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
    startGpu()
    startNet()
    startLhm()
  }

  function stop() {
    active = false
    kill(gpuChild)
    kill(netChild)
    kill(coresChild)
    gpuChild = null
    netChild = null
    coresChild = null
    if (lhmTimer) clearInterval(lhmTimer)
    lhmTimer = null
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
            if (state.net == null && process.platform === 'linux' && action === 'snapshot') {
              sampleNetProc(now)
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