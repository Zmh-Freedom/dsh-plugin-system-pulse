/* dsh-plugin-system-pulse — draggable system HUD rendered in shell.overlay.
   The registration id must equal the package name: the loader keys bundles by
   it, and a mismatch makes boot load the same bundle twice. */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-system-pulse',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const BASE = '/api/system-pulse'
    const POS_KEY = 'dsh-system-pulse:pos'
    const COLLAPSED_KEY = 'dsh-system-pulse:collapsed'
    const CARD_W = 248
    const CARD_H = 192
    // Pointer travel (CSS px) below which a press still counts as a click.
    const DRAG_SLOP = 3

    const CSS = `
.sp-wrap { position: absolute; width: 0; height: 0; pointer-events: none; }
.sp-card {
  position: absolute; width: ${CARD_W}px; box-sizing: border-box;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 93%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  color: var(--dsw-alias-label-primary); pointer-events: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .26);
  font-size: 12px; line-height: 1.35; font-variant-numeric: tabular-nums;
  user-select: none; opacity: .93; transition: opacity .16s ease;
}
.sp-card:hover, .sp-card.is-dragging { opacity: 1; }
.sp-head { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px 0 10px; cursor: grab; }
.sp-card.is-dragging .sp-head { cursor: grabbing; }
.sp-title { flex: 1; min-width: 0; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-live { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-success-primary); }
.sp-live.is-bad { background: var(--dsw-alias-state-error-primary); }
.sp-btn {
  flex: none; width: 18px; height: 18px; display: grid; place-items: center;
  border: none; background: transparent; color: var(--dsw-alias-label-tertiary);
  border-radius: 4px; cursor: pointer; padding: 0; font-size: 13px; line-height: 1;
}
.sp-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sp-body { padding: 1px 0 7px; }
.sp-trend { padding: 1px 10px 7px 47px; }
.sp-spark { display: block; width: 100%; height: 12px; }
.sp-row { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 7px; align-items: center; padding: 2px 10px; }
.sp-k { font-size: 9.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.sp-v { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.sp-num { flex: none; min-width: 42px; text-align: right; font-size: 14px; font-weight: 600; line-height: 1.15; }
.sp-num.is-ghost { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.sp-bar { flex: 1; min-width: 18px; height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.sp-fill { display: block; height: 100%; border-radius: 2px; transition: width .35s ease, background .35s ease; }
.sp-meta { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sp-meta.is-ghost { color: var(--dsw-alias-label-tertiary); }
.sp-cores { display: flex; gap: 2px; padding: 3px 10px 2px 47px; height: 12px; align-items: flex-end; }
.sp-core { flex: 1; min-width: 1px; height: 3px; border-radius: 1px; background: var(--dsw-alias-border-l2); }
.sp-foot { display: flex; gap: 6px; align-items: center; padding: 3px 10px 7px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.sp-foot span { flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Only the hostname may shrink: a long name must not eat the uptime and the
   sampling interval that follow it. */
.sp-foot span:first-child { flex: 0 1 auto; min-width: 0; }
.sp-dot {
  position: absolute; width: 48px; height: 48px; border-radius: 50%;
  pointer-events: auto; cursor: grab; display: grid; place-items: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .28);
  background: conic-gradient(var(--sp-ring) calc(var(--sp-deg) * 1%), var(--dsw-alias-border-l1) 0);
}
.sp-dot.is-dragging { cursor: grabbing; }
.sp-dot-in { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 96%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.sp-pct { font-size: 8px; font-weight: 500; opacity: .72; margin-left: 1px; }
.sp-roll { display: inline-flex; flex-direction: column; height: 9px; overflow: hidden; font-variant-numeric: tabular-nums; position: relative; }
.sp-roll > span { display: block; height: 9px; line-height: 9px; text-align: center; }
.sp-roll.is-rolling > span { position: absolute; left: 0; width: 100%; }
.sp-roll.is-rolling > span:last-child { top: 9px; }
.sp-roll.is-rolling { animation: sp-roll 5.2s steps(1, end) infinite; }
@keyframes sp-roll {
  0%, 40% { }
  41% { translate: 0 -9px; }
  92% { translate: 0 -9px; }
  93%, 100% { translate: 0 0; }
}
.sp-hint {
  position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%) translateX(-3px);
  max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; pointer-events: none;
  display: flex; flex-wrap: wrap; align-items: baseline; row-gap: 2px; max-height: 0;
  padding: 5px 0; border-radius: 8px; box-sizing: border-box;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 93%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  border: 1px solid transparent; color: var(--dsw-alias-label-primary);
  font-size: 11px; line-height: 1.3; font-variant-numeric: tabular-nums;
  box-shadow: 0 8px 22px rgba(0, 0, 0, .22);
  transition: max-width .18s ease, max-height .18s ease, opacity .18s ease, transform .18s ease, padding .18s ease, border-color .18s ease;
}
.sp-dot:hover .sp-hint, .sp-dot.is-dragging .sp-hint, .sp-hint.is-open {
  max-width: 420px; max-height: 300px; opacity: 1; transform: translateY(-50%); padding: 5px 9px; border-color: var(--dsw-alias-border-l1);
}
.sp-hint-k { color: var(--dsw-alias-label-tertiary); font-size: 10px; margin-right: 4px; }
.sp-hint-v { font-weight: 600; margin-right: 8px; }
/* Near the right edge the bubble has to grow to the left instead. */
.sp-hint.is-left { left: auto; right: calc(100% + 8px); transform: translateY(-50%) translateX(3px); }
/* Side by side the bubble would eat the whole screen edge, so a ring near the
   right edge gets a narrow one that stacks its rows instead. */
.sp-hint.is-left.is-open, .sp-dot:hover .sp-hint.is-left { max-width: 178px; }
.sp-dot:hover .sp-hint.is-left, .sp-hint.is-left.is-open { transform: translateY(-50%); }
@media (prefers-reduced-motion: reduce) { .sp-fill { transition: none; } .sp-roll.is-rolling { animation: none; } .sp-hint { transition: none; } }
`

    const EN = {
      title: 'System Pulse',
      cpu: 'CPU',
      gpu: 'GPU',
      mem: 'MEM',
      net: 'NET',
      temp: 'TEMP',
      fan: 'fan',
      offline: 'offline',
      unavailable: 'unavailable',
      sampling: 'sampling…',
      collapse: 'Collapse',
      expand: 'Expand',
      up: 'up',
      vram: 'VRAM',
      shared: 'unified memory',
      ringHint: 'CPU load',
    }
    const ZH = {
      title: '系统脉搏',
      cpu: '处理器',
      gpu: '显卡',
      mem: '内存',
      net: '网络',
      temp: '温度',
      fan: '风扇',
      offline: '连接中断',
      unavailable: '不可用',
      sampling: '采样中…',
      collapse: '收起',
      expand: '展开',
      up: '运行',
      vram: '显存',
      shared: '统一内存',
      ringHint: '处理器占用',
    }

    function loadPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed
      } catch {
        /* ignore */
      }
      return null
    }

    function clampPos(pos, collapsed) {
      const w = collapsed ? 48 : CARD_W
      const h = collapsed ? 48 : CARD_H
      const maxX = Math.max(4, window.innerWidth - w - 4)
      const maxY = Math.max(4, window.innerHeight - h - 4)
      return {
        x: Math.min(Math.max(4, pos.x), maxX),
        y: Math.min(Math.max(4, pos.y), maxY),
      }
    }

    function defaultPos() {
      return clampPos(
        { x: window.innerWidth - CARD_W - 24, y: window.innerHeight - CARD_H - 88 },
        false,
      )
    }

    function pct(value) {
      return value == null ? '—' : `${Math.round(value * 100)}%`
    }

    function rate(bytesPerSec) {
      if (bytesPerSec == null) return '—'
      const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
      let value = bytesPerSec
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
    }

    function gib(bytes) {
      return (bytes / 1024 ** 3).toFixed(1)
    }

    function uptime(ms, t) {
      if (ms == null) return ''
      const totalMinutes = Math.floor(ms / 60000)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      const zh = t('up') === '运行'
      if (days > 0) return zh ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`
      if (hours > 0) return zh ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`
      return zh ? `${minutes} 分钟` : `${minutes}m`
    }

    function toneFor(value, warn, danger) {
      if (value == null) return 'var(--dsw-alias-label-tertiary)'
      if (value >= danger) return 'var(--dsw-alias-state-error-primary)'
      if (value >= warn) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    function Spark({ points, tone }) {
      if (!points || points.length < 2) return null
      const width = 100
      const height = 14
      const step = width / (points.length - 1)
      const coords = points.map((point, index) => {
        const value = Math.min(1, Math.max(0, point))
        const y = height - 1.5 - value * (height - 3)
        return `${(index * step).toFixed(1)},${y.toFixed(1)}`
      })
      return h(
        'svg',
        {
          className: 'sp-spark',
          viewBox: `0 0 ${width} ${height}`,
          preserveAspectRatio: 'none',
          'aria-hidden': true,
        },
        h('polygon', {
          points: `0,${height} ${coords.join(' ')} ${width},${height}`,
          fill: tone,
          opacity: 0.14,
        }),
        h('polyline', {
          points: coords.join(' '),
          fill: 'none',
          stroke: tone,
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let styles = null
        try {
          styles = require('styles')
        } catch {
          styles = null
        }
        if (styles && typeof styles.insert === 'function') {
          ctx.effect(() => styles.insert(CSS))
        } else {
          ctx.effect(() => {
            const element = document.createElement('style')
            element.textContent = CSS
            document.head.appendChild(element)
            return () => element.remove()
          })
        }

        ctx.effect(() => ctx.locale.register('system-pulse', 'en', EN))
        ctx.effect(() => ctx.locale.register('system-pulse', 'zh', ZH))
        ctx.effect(() => ctx.locale.register('system-pulse', 'zh-CN', ZH))
        const t = ctx.locale.bind('system-pulse')

        function Pulse() {
          const [, setRevision] = useState(0)
          const [snapshot, setSnapshot] = useState(null)
          const [failed, setFailed] = useState(false)
          const [collapsed, setCollapsed] = useState(() => {
            try {
              return window.localStorage.getItem(COLLAPSED_KEY) === '1'
            } catch {
              return false
            }
          })
          const [pos, setPos] = useState(() => {
            const stored = loadPos()
            return clampPos(stored ?? (defaultPos() || { x: 24, y: 24 }), collapsed)
          })
          const [dragging, setDragging] = useState(false)
          const wrapRef = useRef(null)
          const originRef = useRef({ x: 0, y: 0 })
          const posRef = useRef(pos)
          const dragRef = useRef(null)
          const collapsedRef = useRef(collapsed)

          posRef.current = pos
          collapsedRef.current = collapsed

          useEffect(() => {
            const unsubscribe = ctx.locale.subscribe(() => setRevision((value) => value + 1))
            return unsubscribe
          }, [])

          useEffect(() => {
            const element = wrapRef.current
            if (element) {
              const rect = element.getBoundingClientRect()
              originRef.current = { x: rect.left, y: rect.top }
            }
          }, [])

          useEffect(() => {
            const onResize = () => setPos((current) => clampPos(current, collapsedRef.current))
            window.addEventListener('resize', onResize)
            return () => window.removeEventListener('resize', onResize)
          }, [])

          useEffect(() => {
            let alive = true
            let timer = null
            let delay = 1000
            let firstTick = true
            const tick = async () => {
              const visible = document.visibilityState === 'visible'
              // The first reading never waits for visibility: opening the HUD
              // should show numbers immediately, and one fetch is a useful
              // mount signal even while the window sits in the background.
              if (alive && (firstTick || visible)) {
                if (firstTick) firstTick = false
                try {
                  const response = await fetch(`${BASE}/snapshot?window=60`, { cache: 'no-store' })
                  if (!response.ok) throw new Error(`HTTP ${response.status}`)
                  const data = await response.json()
                  if (!alive) return
                  setSnapshot(data)
                  setFailed(false)
                  if (Number.isFinite(data?.intervalMs) && data.intervalMs >= 250) delay = data.intervalMs
                } catch {
                  if (alive) setFailed(true)
                }
              }
              if (alive) timer = setTimeout(tick, delay)
            }
            tick()
            return () => {
              alive = false
              if (timer) clearTimeout(timer)
            }
          }, [])

          const persist = () => {
            try {
              window.localStorage.setItem(POS_KEY, JSON.stringify(posRef.current))
              window.localStorage.setItem(COLLAPSED_KEY, collapsedRef.current ? '1' : '0')
            } catch {
              /* ignore */
            }
          }

          const beginDrag = (event) => {
            if (event.button !== 0) return
            // A drag surface must let real controls inside it work: the
            // collapse button lives in the head, and capturing the pointer on
            // the head retargets the following click away from that button.
            // Matched on the element, not on .sp-btn: the collapsed ring is a
            // button too, and it needs the same escape.
            if (event.target?.closest?.('button')) return
            event.preventDefault()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            dragRef.current = {
              id: event.pointerId,
              dx: event.clientX - posRef.current.x,
              dy: event.clientY - posRef.current.y,
              x0: event.clientX,
              y0: event.clientY,
              moved: false,
            }
            setDragging(true)
          }

          const moveDrag = (event) => {
            const drag = dragRef.current
            if (!drag || event.pointerId !== drag.id) return
            if (
              !drag.moved &&
              Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) >= DRAG_SLOP
            ) {
              drag.moved = true
            }
            setPos(
              clampPos(
                { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
                collapsedRef.current,
              ),
            )
          }

          // A pointer that travelled is a drag, not a click: swallow the click
          // the browser synthesises afterwards, or dropping the dot expands the
          // card the user was only moving. The flag has to outlive pointerup —
          // the click arrives after it, when dragRef is already cleared.
          const swipeClickRef = useRef(false)
          const swallowClickAfterDrag = (event) => {
            if (!swipeClickRef.current) return
            swipeClickRef.current = false
            event.preventDefault()
            event.stopPropagation()
          }

          const endDrag = (event) => {
            const drag = dragRef.current
            if (!drag) return
            dragRef.current = null
            swipeClickRef.current = drag.moved
            setDragging(false)
            try {
              event.currentTarget.releasePointerCapture?.(drag.id)
            } catch {
              /* ignore */
            }
            persist()
          }

          const dragProps = {
            onPointerDown: beginDrag,
            onPointerMove: moveDrag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            style: { touchAction: 'none' },
          }

          const collapseProps = {
            onClick: (event) => {
              event.stopPropagation()
              toggle(event)
            },
            // Stop the press from reaching the drag surface at all. Relying on
            // beginDrag's target check alone is not enough: in the collapsed
            // dot the button is the dot's only child, so an unstopped press
            // would be captured and the click retargeted to the dot.
            onPointerDown: (event) => event.stopPropagation(),
          }

          const toggle = (event) => {
            event.stopPropagation()
            const next = !collapsedRef.current
            collapsedRef.current = next
            setCollapsed(next)
            const clamped = clampPos(posRef.current, next)
            setPos(clamped)
            posRef.current = clamped
            setTimeout(persist, 0)
          }

          const origin = originRef.current
          const left = pos.x - origin.x
          const top = pos.y - origin.y
          const cpu = snapshot?.cpu
          const mem = snapshot?.mem
          const gpu = snapshot?.gpu
          const net = snapshot?.net
          const temps = snapshot?.temps
          const health = snapshot?.health ?? {}
          const history = snapshot?.history ?? []
          const cpuTone = toneFor(cpu?.usage, 0.65, 0.85)
          const memTone = toneFor(mem?.usage, 0.78, 0.9)
          const cpuMark = Math.round((cpu?.usage ?? 0) * 360)
          const platform = snapshot?.host?.platform ?? ''

          // A probe that has not delivered its first reading yet is still
          // starting up (the network relay needs one sample interval, ioreg
          // and netstat need their first delta), which is not the same thing
          // as being unavailable on this machine.
          const pending = (probe) =>
            probe?.state === 'idle' || probe?.state === 'sampling' || probe?.state === 'starting'
          const ghostText = (probe) => (pending(probe) ? t('sampling') : probe?.reason ?? t('unavailable'))

          if (collapsed) {
            const ringValue = pct(cpu?.usage)
            const hintLeft = (pos.x - origin.x) + 48 + 12 > window.innerWidth
            // A probe without a reading still gets a row: on this machine it
            // may simply be unavailable, and hiding the row would leave the
            // hover hint silently short of an answer.
            const hintRow = (label, value) =>
              h(
                'span',
                { key: label },
                h('span', { className: 'sp-hint-k' }, label),
                h('span', { className: 'sp-hint-v' }, value ?? '—'),
              )
            return h(
              'div',
              { className: 'sp-wrap', ref: wrapRef },
              h(
                'div',
                {
                  className: `sp-dot${dragging ? ' is-dragging' : ''}`,
                  ...dragProps,
                  style: {
                    ...dragProps.style,
                    left,
                    top,
                    '--sp-ring': cpuTone,
                    '--sp-deg': cpuMark / 3.6,
                  },
                  title: `${t('title')} · ${t('ringHint')} ${ringValue} · ${t('expand')}`,
                  'aria-label': `${t('title')} · ${t('ringHint')} ${ringValue}`,
                  onClick: toggle,
                  onClickCapture: swallowClickAfterDrag,
                },
                // One character at a time fits inside the ring: the number and
                // its tens digit alternate, and the ring itself carries the
                // rest of the scale.
                h(
                  'div',
                  { className: 'sp-dot-in' },
                  cpu
                    ? h(
                        'span',
                        { className: 'sp-roll' + (cpu.usage >= 0.1 ? ' is-rolling' : '') },
                        h('span', null, `${Math.round(cpu.usage * 100)}`),
                        h('span', null, `${Math.round(cpu.usage * 10)}`),
                      )
                    : '—',
                  h('span', { className: 'sp-pct' }, '%'),
                ),
                h(
                  'div',
                  { className: `sp-hint${hintLeft ? ' is-left' : ''}`, 'aria-hidden': 'true' },
                  h('span', { className: 'sp-hint-k' }, t('ringHint')),
                  h('span', { className: 'sp-hint-v' }, ringValue),
                  hintRow(t('gpu'), gpu ? pct(gpu.usage) : ghostText(health?.gpu)),
                  hintRow(t('mem'), mem ? pct(mem.usage) : ghostText(health?.mem)),
                  hintRow(t('net'), net ? `↓ ${rate(net.rxBps)} ↑ ${rate(net.txBps)}` : ghostText(health?.net)),
                ),
              ),
            )
          }

          const row = (label, value, barValue, barTone, meta, ghost) =>
            h(
              'div',
              { className: 'sp-row', key: label },
              h('span', { className: 'sp-k' }, label),
              h(
                'div',
                { className: 'sp-v' },
                h('span', { className: `sp-num${ghost ? ' is-ghost' : ''}`, style: ghost ? undefined : { color: barTone } }, value),
                barValue == null
                  ? null
                  : h(
                      'span',
                      { className: 'sp-bar' },
                      h('i', {
                        className: 'sp-fill',
                        style: {
                          width: `${Math.round(Math.min(1, Math.max(0, barValue)) * 100)}%`,
                          background: barTone,
                        },
                      }),
                    ),
                meta ? h('span', { className: `sp-meta${ghost ? ' is-ghost' : ''}`, title: meta.title }, meta.text) : null,
              ),
            )

          const cpuThermal = temps
            ? [
                temps.cpuC != null ? `${Math.round(temps.cpuC)}°C` : null,
                temps.cpuPowerW != null ? `${Math.round(temps.cpuPowerW)}W` : null,
                temps.fanRpm != null && temps.fanRpm > 0 ? `${Math.round(temps.fanRpm)} rpm` : null,
              ].filter(Boolean)
            : []

          // Apple Silicon reports its physical cores split into performance and
          // efficiency clusters; "10C/10T" would read like hyper-threading that
          // does not exist there.
          const cpuShape = !cpu
            ? ''
            : cpu.perfCores && cpu.effCores
              ? `${cpu.perfCores}P+${cpu.effCores}E`
              : cpu.cores
                ? `${cpu.cores}C/${cpu.threads}T`
                : `${cpu.threads}T`
          const cpuClockNote = !cpu
            ? ''
            : cpu.clockMHz
              ? `实时 ${(cpu.clockMHz / 1000).toFixed(2)} GHz · 标称 ${(cpu.speedMHz / 1000).toFixed(1)} GHz`
              : platform === 'darwin'
                ? `标称 ${(cpu.speedMHz / 1000).toFixed(1)} GHz（Apple Silicon 不向非特权进程提供实时频率）`
                : `标称 ${(cpu.speedMHz / 1000).toFixed(1)} GHz（实时频率需要系统性能计数器）`

          const cpuMeta = cpu
            ? {
                // Thermal readings take the slot when LibreHardwareMonitor is
                // reachable; otherwise fall back to the structure and clock.
                text: cpuThermal.length
                  ? cpuThermal.join(' · ')
                  : `${cpuShape} · ${((cpu.clockMHz ?? cpu.speedMHz) / 1000).toFixed(2)}G`,
                title: [
                  cpu.model,
                  cpu.perfCores && cpu.effCores
                    ? `${cpu.cores} 物理核：${cpu.perfCores} 性能核 + ${cpu.effCores} 能效核`
                    : cpu.cores
                      ? `${cpu.cores} 物理核 / ${cpu.threads} 逻辑处理器`
                      : `${cpu.threads} 逻辑处理器`,
                  cpuClockNote,
                  temps
                    ? [
                        temps.cpuC != null ? `封装温度 ${Math.round(temps.cpuC)}°C（Core Tctl/Tdie）` : null,
                        temps.cpuPowerW != null ? `封装功耗 ${Math.round(temps.cpuPowerW)}W（Package）` : null,
                        temps.fanRpm != null ? `主板风扇 ${Math.round(temps.fanRpm)} RPM（SuperIO）` : null,
                        `温度来源：${temps.source ?? 'LibreHardwareMonitor'}`,
                      ]
                        .filter(Boolean)
                        .join('\n')
                    : `温度不可用：${ghostText(health?.temps)}`,
                ].join('\n'),
              }
            : null

          const gpuMeta = gpu
            ? {
                // NVIDIA cards expose temperature and power; the macOS probe
                // has neither, so the slot shows the unified-memory working set.
                text: [
                  gpu.tempC != null ? `${Math.round(gpu.tempC)}°C` : null,
                  gpu.powerW != null ? `${Math.round(gpu.powerW)}W` : null,
                ].filter(Boolean).join(' · ') ||
                  (gpu.memUsed != null
                    ? gpu.memTotal != null
                      ? `${gib(gpu.memUsed)}/${gib(gpu.memTotal)}G`
                      : `${gib(gpu.memUsed)}G`
                    : gpu.cores
                      ? `${gpu.cores} 核`
                      : ''),
                title: [
                  gpu.name,
                  gpu.cores ? `${gpu.cores} 个 GPU 核心` : null,
                  gpu.memUsed != null
                    ? `${gpu.shared ? t('shared') : t('vram')} ${gib(gpu.memUsed)}${gpu.memTotal != null ? ` / ${gib(gpu.memTotal)}` : ''} GB`
                    : null,
                  gpu.clockMHz != null ? `${gpu.clockMHz} MHz` : null,
                ]
                  .filter(Boolean)
                  .join('\n'),
              }
            : null

          const memMeta = mem
            ? {
                text: `${gib(mem.used)}/${gib(mem.total)}G`,
                title: [
                  `内存 ${gib(mem.used)} / ${gib(mem.total)} GB`,
                  mem.source === 'vm_stat' ? '口径：vm_stat（与活动监视器一致：匿名 − 可清除 + 联动 + 压缩）' : null,
                  mem.swapTotal != null
                    ? // macOS grows the swap files while the page count is
                      // already rising, so a reading can briefly report more
                      // used than total; never print an impossible fraction.
                      `交换空间 ${gib(mem.swapUsed ?? 0)} / ${gib(Math.max(mem.swapTotal, mem.swapUsed ?? 0))} GB`
                    : null,
                ]
                  .filter(Boolean)
                  .join('\n'),
              }
            : null

          const anyBad = failed

          return h(
            'div',
            { className: 'sp-wrap', ref: wrapRef },
            h(
              'div',
              {
                className: `sp-card${dragging ? ' is-dragging' : ''}`,
                style: { left, top },
              },
              h(
                'div',
                { className: 'sp-head', ...dragProps },
                h('span', { className: `sp-live${anyBad ? ' is-bad' : ''}`, title: anyBad ? t('offline') : t('title') }),
                h('span', { className: 'sp-title' }, anyBad ? `${t('title')} · ${t('offline')}` : t('title')),
                h(
                  'button',
                  { className: 'sp-btn', ...collapseProps, title: t('collapse'), 'aria-label': t('collapse') },
                  '–',
                ),
              ),
              h(
                'div',
                { className: 'sp-body' },
                row(t('cpu'), pct(cpu?.usage), cpu?.usage ?? null, cpuTone, cpuMeta, !cpu),
                h(
                  'div',
                  { className: 'sp-cores' },
                  (cpu?.perCore ?? []).map((value, index) =>
                    h('i', {
                      key: index,
                      className: 'sp-core',
                      style: {
                        height: `${3 + Math.round(value * 7)}px`,
                        background: toneFor(value, 0.65, 0.85),
                        opacity: 0.55 + value * 0.45,
                      },
                    }),
                  ),
                ),
                h('div', { className: 'sp-trend' }, h(Spark, { points: history.map((point) => point.c), tone: cpuTone })),
                gpu
                  ? row(t('gpu'), pct(gpu.usage), gpu.usage, toneFor(gpu.usage, 0.75, 0.95), gpuMeta, false)
                  : row(t('gpu'), '—', null, null, { text: ghostText(health?.gpu), title: pending(health?.gpu) ? '' : health?.gpu?.reason ?? '' }, true),
                row(t('mem'), pct(mem?.usage), mem?.usage ?? null, memTone, memMeta, !mem),
                h(
                  'div',
                  { className: 'sp-row', key: 'net' },
                  h('span', { className: 'sp-k' }, t('net')),
                  h(
                    'div',
                    { className: 'sp-v' },
                    net
                      ? h(
                          'span',
                          { className: 'sp-meta', style: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px' } },
                          `↓ ${rate(net.rxBps)}`,
                        )
                      : h('span', { className: 'sp-num is-ghost' }, '—'),
                    net
                      ? h('span', { className: 'sp-meta', style: { fontSize: '12px' } }, `↑ ${rate(net.txBps)}`)
                      : h('span', { className: 'sp-meta is-ghost', title: pending(health?.net) ? '' : health?.net?.reason ?? '' }, ghostText(health?.net)),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'sp-foot' },
                h('span', { title: snapshot?.host?.name ?? '' }, (snapshot?.host?.name ?? '—').replace(/\.local$/, '')),
                h('span', null, '·'),
                h('span', null, `↑ ${uptime(snapshot?.host?.uptimeMs, t)}`),
                h('span', null, '·'),
                h('span', null, `${Math.round((snapshot?.intervalMs ?? 1000) / 100) / 10}s`),
              ),
            ),
          )
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'system-pulse', order: 40 }, Pulse),
        )
      },
    }
  },
})