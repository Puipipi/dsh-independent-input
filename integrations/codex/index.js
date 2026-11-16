/**
 * dsh-independent-input · 独立鼠标键盘
 *
 * 只做“输入”这一层：鼠标、键盘、滚轮、拖拽、截图定位。
 * 默认走 UIA / 窗口消息，不移动主人的真实光标、不抢键盘焦点；physical 已禁用。
 */

import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InputEngine } from './lib/engine.js'
import { normalizeFocusPolicy, focusPolicyBlock, keyboardContractBlock } from './lib/focus-policy.js'
import { presentObservation, presentWindows, presentStatus, presentControl, screenshotEvidence, observationEvidenceNote } from './lib/presentation.js'
import { placeWindow, openOnMonitor } from './lib/window-actions.js'
import { resolvePreferredMonitor } from './lib/window-placement.js'
import { stopText } from './lib/stop-info.js'
import {resolveAssets} from './lib/asset-paths.js'
import { threadCaption } from './lib/thread-caption.js'

export const name = 'independent-input'
export const inject = ['tools', 'attachments', 'webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PREVIEW_DIR = join(resolveAssets(PLUGIN_DIR), 'previews')
const SETTINGS_FILE = join(homedir(), '.dsh', 'independent-input', 'settings.json')
const STYLE_IDS = [
  'pointer', 'work', 'unavailiable', 'link', 'text',
  'cross', 'busy', 'move', 'vert', 'horz',
  'help', 'handwriting', 'dgn1', 'dgn2', 'alternate',
]

function toLosslessJson(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(toLosslessJson)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = toLosslessJson(item)
  return out
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod?.defineTool) return mod.defineTool
  } catch { /* 本地测试时走环境变量 */ }
  const override = process.env.DSH_TOOLS_PATH
  if (override) {
    const { pathToFileURL } = await import('node:url')
    const mod = await import(pathToFileURL(override).href)
    if (mod?.defineTool) return mod.defineTool
  }
  // 最小兜底：只在没有 DSH 的单元测试里用；真实宿主一定有 dsh-tools。
  return (definition) => definition
}

function statusText(s) {
  const paused = s?.paused ? `已暂停（${s.pauseReason || '主人接管'}）` : '运行中'
  const age = Number.isFinite(s?.lastUserInputAgeMs) && s.lastUserInputAgeMs >= 0
    ? `${Math.round(s.lastUserInputAgeMs)}ms 前`
    : '还没记录'
  const fg = presentStatus(s || {}).foreground.title || presentStatus(s || {}).foreground.className || '未知'
  const cursor = s?.cursor ? `(${s.cursor.x}, ${s.cursor.y})` : '未知'
  const size = s?.cursorSize === 0 ? `系统大小×1.5625（当前${s?.displaySize ?? '?'}px）` : `${s?.displaySize ?? s?.cursorSize ?? '?'}px`
  const mode = s?.cursorMode === 'clean'
    ? `整洁模式（动作后约 ${s?.cursorHoldMs || 2600}ms 收起，${size} · ${s?.cursorState || 'pointer'}）`
    : `陪伴模式（一直显示，${size} · ${s?.cursorState || 'pointer'}）`
  const lines = [
    `独立输入${s?.runtimeVersion?' v'+s.runtimeVersion:''}：${paused}`,
    ...(s?.control ? [`控制权[${s.control.scope}]：${s.control.busy===null?'未知，禁止获取':s.control.busy?'占用':'空闲'} · 项目=${s.control.ownerProjectName||'项目暂不可用'} · owner=${s.control.ownerName||(s.control.busy?'会话名称暂不可用':'无')} · ${s.control.reason} · 官方CU=${s.control.externalOfficialState}`] : []),
    ...(s?.control?.queue?.length?[`排队：${s.control.queue.map(t=>`${t.position}. ${t.projectName||'项目暂不可用'} / ${t.name||'会话名称暂不可用'}`).join('；')}`]:[]),
    ...((s?.stopInfo||s?.control?.stopInfo||s?.lastStop||s?.control?.lastStop)?[`${s.paused?'当前停止':'最近停止（当前未暂停）'}：${stopText(s.stopInfo||s.control?.stopInfo||s.lastStop||s.control?.lastStop)}`]:[]),
    `主人最近一次真实输入：${age}`,
    `真实光标：${cursor} · AI 光标：${s?.overlay ? '显示' : '隐藏'} · ${mode}`,
    `前台窗口：${fg}`,
  ]
  if (s?.paused) {
    lines.push('⚠ 主人已经暂停/接管输入。不要继续操作；等主人说“继续”，再调用 action:"resume"。')
  } else {
    lines.push(`主人随时可按 ${s?.hotkey || 'Esc（active时）或Ctrl+Alt+Q'} 暂停。`)
  }
  return lines.join('\n')
}

function windowsText(r) {
  const list = Array.isArray(r?.windows) ? r.windows : []
  if (!list.length) return '没读到可用窗口。'
  const lines = list.slice(0, 24).map((w) => {
    const rect = w.rect ? `${w.rect.x},${w.rect.y} ${w.rect.w}x${w.rect.h}` : '?'
    const mark = w.foreground ? ' ★前台' : ''
    return `hwnd ${w.hwnd} · ${w.title} · ${rect} · ${w.process || ''}${mark}`.trim()
  })
  if (list.length > 24) lines.push(`……还有 ${list.length - 24} 个窗口未列出`)
  return lines.join('\n')
}

function resultText(action, r) {
  if(r?.reason==='overlay-position-failed')return 'AI光标定位/显示失败；没有重发应用输入。请检查实际状态。'

  if (!r || typeof r !== 'object') return `已执行 ${action}。`
  if (r.paused) {
    const uncertain = r.partial || r.reason === 'paused-partial' || r.opened
    return `⚠ 已暂停。${uncertain ? '可能已部分完成，已停止后续投递；先观察，禁止自动重发。' : '未继续派发本次动作。'}\n${r.note || '等主人说继续，再 action:"resume"。'}`
  }
  if (r.ok === false) {
    const bits = [`未完成（${r.reason || '未知原因'}）`]
    if (r.name) bits.push(`目标：${r.name}`)
    if (r.type) bits.push(`类型：${r.type}`)
    if (r.note) bits.push(r.note)
    if (r.needsPhysical) bits.push('不会退回 physical；请改用目标 hwnd 的其他窗口消息方式，或问主人。')
    if (r.strictNoRealMouse || r.strictNoFocusSteal) bits.push('已严格禁止真实鼠标 / 抢焦点。')
    return bits.join('\n')
  }
  if (action === 'capture') {
    return `截图已保存：${r.path}\n${r.attached ? '图已附在本条结果里。' : '图片未附；请按保存路径用当前环境可用的图片查看方式查看。'}`
  }
  if (action === 'overlay') {
    if (r.visible === false) return 'AI 光标已隐藏；主人的真实光标没有移动。'
    const mode = r.cursorMode === 'clean' ? '整洁模式（一会儿自动收起）' : '陪伴模式（一直显示）'
    return `AI 光标已到 (${r.x ?? '?'}, ${r.y ?? '?'}) · ${mode} · ${r.cursorSize === 0 ? '系统大小×1.5625' : (r.displaySize ?? r.cursorSize ?? '?') + 'px'} · ${r.cursorState || 'pointer'}；主人的真实光标没有移动。`
  }
  if (action === 'move') {
    const mode = r.cursorMode === 'clean' ? '整洁模式（一会儿自动收起）' : '陪伴模式（一直显示）'
    return `AI 光标已到 (${r.x ?? '?'}, ${r.y ?? '?'}) · ${mode} · ${r.cursorSize === 0 ? '系统大小×1.5625' : (r.displaySize ?? r.cursorSize ?? '?') + 'px'} · ${r.cursorState || 'pointer'}；主人的真实光标没有移动。`
  }
  const via = r.via || 'unknown'
  if (via === 'uia') {
    return `UIA 已执行（${r.pattern || 'pattern'}）${r.name ? `：${r.name}` : ''}${r.type ? ` · ${r.type}` : ''}`
  }
  if (via === 'bm_click') {
    return `已向按钮发 BM_CLICK；没有移动鼠标，也没有抢焦点。`
  }
  if (via === 'uia-hwnd') {
    return `目标窗口内 UIA 已执行（${r.pattern || 'pattern'}）${r.name ? `：${r.name}` : ''}${r.type ? ` · ${r.type}` : ''}`
  }
  if (via === 'wm_settext') {
    return `已直接写入控件${r.verified ? '（已回读确认）' : ''}；没有移动光标，也没有抢焦点。`
  }
  if (via === 'uia-focus+physical') {
    return `physical 已禁用；这条回执不该出现，请检查版本。`
  }
  if (via === 'uia+message') {
    return `已向目标窗口投递文字${r.verified ? '（已确认）' : '（需截图确认）'}；没有抢焦点。`
  }
  if (via === 'message-hwnd') {
    const target = r.title ? `“${r.title}”` : (r.hwnd ? `hwnd ${r.hwnd}` : '目标')
    return `已向 ${target} 投递窗口消息${r.verified ? '（已确认）' : '（不一定被处理，请截图确认）'}；没有动真实鼠标。`
  }
  if (via === 'message') {
    const target = r.title ? `“${r.title}”` : (r.hwnd ? `hwnd ${r.hwnd}` : '目标')
    return `窗口消息已投递给 ${target}${r.verified ? '（已确认）' : '（不一定被处理，请截图确认）'}。`
  }
  if (via === 'physical') {
    return `physical 已禁用；这条回执不该出现。`
  }
  return `已执行 ${action}：${JSON.stringify(r).slice(0, 600)}`
}

function toolSpec() {
  return {
    name: 'independent_input',
    description: 'Windows桌面默认独立输入。先status/windows确定授权hwnd，observe返回provider报告的UIA与可选截图；UIA/offscreen=false不保证当前可见，mappingVerified/occlusionSafe不验证业务内容fresh。有图先看实际画面，冲突仅只读fresh核对，不盲重试或自动改焦点/搬窗/切官方CU。用observationId+elementId执行一次click/type再observe。旧hwnd+物理坐标兼容。窗口capture不屏幕回退；mappingVerified=false不能从图片推坐标，显式rect/full为遮挡不安全的screen-copy。bounds仅授权搬窗，不激活。physical禁用，不主动移动系统鼠标/设置焦点；应用自身可能改变焦点。idle输入或begin开始，finish收尾且后续须begin；active物理Esc/CtrlAltQ暂停，begin不清暂停，resume仅用户明确继续。普通键鼠不结束。遵守宿主stop/权限，不自动切原生CUA。',
    parameters: {
      waitMs: {type:'number',description:'control_wait：单次等待0–45000ms；超时不授锁、不重放输入'},
      action: {
        type: 'string',
        required: true,
        description: 'control_request | control_wait | control_cancel | status | windows | observe | capture | click | type | key | scroll | drag | move | bounds | place | open | begin | finish | pause | resume | overlay',
      },
      windowObservationId: { type: 'string', description: 'observe返回的窗口几何guard；坐标click/type/key/scroll/drag可选，单次消费，与元素observationId/elementId互斥。仅核根runtime/几何，不保证内容原子快照。' },
      details: { type: 'boolean', description: 'observe显式详细字段（默认紧凑）；内部完整签名不受影响' },
      maxTextChars: { type: 'integer', description: '外发Name/Value/标题每字段字符上限，1–16384，默认256；截断会返回Length/Truncated，不能视为全文' },
      title: { type: 'string', description: 'windows标题包含过滤（不区分大小写）' },
      className: { type: 'string', description: 'windows类名包含过滤' },
      pid: { type: 'integer', description: 'windows精确进程ID过滤' },
      offset: { type: 'integer', description: 'windows过滤后分页偏移，默认0' },
      limit: { type: 'integer', description: 'windows页大小，1–100，默认24' },
      monitor: { type: 'string', description: 'place/open目标显示器：secondary（默认）、primary或windows/status返回的device；不自动移动其他已有窗口' },
      observationId: { type: 'string', description: 'observe返回的本进程新鲜观察ID；元素click/type时与elementId和hwnd一起提供，动作后失效' },
      elementId: { type: 'string', description: '本次observe返回的元素ID；不可使用sky索引或旧观察元素' },
      maxElements: { type: 'integer', description: 'observe最多返回元素数，1–500，默认150' },
      includeScreenshot: { type: 'boolean', description: 'observe可选截图；默认false仅provider UIA，无视觉证据。true核对截图前后几何；实际附图后先看图确认场景/目标，内容freshness仍未验证' },
      width: { type: 'integer', description: 'bounds目标窗口外框物理宽度，必须正整数；仅获授权搬窗时使用' },
      height: { type: 'integer', description: 'bounds目标窗口外框物理高度，必须正整数' },
      x: { type: 'number', description: '屏幕绝对 x（click/type/key/scroll/drag 的起点/move/overlay）' },
      y: { type: 'number', description: '屏幕绝对 y' },
      toX: { type: 'number', description: 'drag 终点 x' },
      toY: { type: 'number', description: 'drag 终点 y' },
      button: { type: 'string', description: 'left（默认）或 right' },
      count: { type: 'integer', description: '点击次数，默认 1；2 = 双击' },
      text: { type: 'string', description: 'type 要输入的文字' },
      replace: { type: 'boolean', description: 'type：true 覆盖原内容，false（默认）追加' },
      keys: { type: 'string', description: 'key：组合键，如 "ctrl+c"、"alt+tab"、"enter"' },
      mode: {
        type: 'string',
        description: 'auto/message：native后台消息；ID仅支持标准Button/Edit。value：仅type+fresh元素双ID，窄ValuePattern写入/回读，可能由provider自行激活，不保证DOM事件。uia：默认preserve拒绝；仅用户持久allow-activation配置允许，仍可能激活。physical禁用',
      },
      delta: { type: 'number', description: 'scroll 滚轮量：正数向上、负数向下，默认 -120' },
      durationMs: { type: 'number', description: 'drag 持续时间，默认 400ms' },
      hwnd: { type: 'number', description: '目标窗口句柄：click/scroll/drag/type/key 必填（先用 windows 拿 hwnd）；不传会拒绝，避免碰主人的窗口' },
      path: { type: 'string', description: 'capture 保存 PNG 的绝对路径；省略则自动放 ~/.dsh/independent-input/shots/' },
      rect: { type: 'string', description: 'capture 区域："x,y,w,h" 或 "full"；省略则截当前前台窗口' },
      show: { type: 'boolean', description: 'overlay：false 隐藏 AI 光标，true/省略 显示' },
      cursorMode: {
        type: 'string',
        description: 'overlay：companion（陪伴，一直显示，默认）| clean（整洁，动作后自动收起）',
      },
      cursorState: {type:'string',enum:STYLE_IDS,description:'overlay：保留指定pointer/link/text等素材状态，与位置/尺寸同批显示'},
      cursorSize: {
        type: 'number',
        description: 'overlay：0随目标屏Windows系统光标大小×1.5625（默认）；24–192为手动显示像素',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          images: { type: 'array', items: { type: 'object', additionalProperties: true } },
          meta: { type: 'object', additionalProperties: true },
        },
      },
      render(_args, value) {
        const blocks = []
        for (const image of value.images || []) blocks.push({ type: 'image', attachment: image })
        blocks.push({ type: 'text', text: value.text })
        return blocks
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe() {
      return false
    },
  }
}

function normalizeSettings(input, fallback = {}) {
  const merged = { ...(fallback || {}), ...(input || {}) }
  const mode = merged.cursorMode === 'clean' ? 'clean' : 'companion'
  const hold = Number(merged.cursorHoldMs)
  const size = Number(merged.cursorSize)
  return {
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : true,
    cursorMode: mode,
    focusPolicy: normalizeFocusPolicy(merged.focusPolicy),
    preferredMonitor: typeof merged.preferredMonitor === 'string' && merged.preferredMonitor.trim() ? merged.preferredMonitor.trim() : 'secondary',
    cursorHoldMs: Number.isFinite(hold) ? Math.max(300, Math.min(10000, Math.round(hold))) : 2600,
    cursorSize: !Number.isFinite(size) || size === 0 ? 0 : Math.max(24, Math.min(192, Math.round(size))),
  }
}

async function loadSavedSettings(log = () => {}, settingsFile = SETTINGS_FILE) {
  try {
    const raw = await readFile(settingsFile, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function persistSettings(settings, settingsFile = SETTINGS_FILE) {
  const existing = await loadSavedSettings(() => {}, settingsFile)
  await mkdir(dirname(settingsFile), { recursive: true })
  await writeFile(settingsFile, `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`, 'utf8')
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

export async function apply(ctx, rawConfig = {}, runtime = {}) {
  const defineTool = runtime.defineTool || await loadDefineTool()
  const log = (message) => { try { ctx?.logger?.info?.(`[independent-input] ${message}`) } catch { /* ignore */ } }
  const saved = await loadSavedSettings(log, runtime.settingsFile)
  let current = normalizeSettings(saved, normalizeSettings(rawConfig))
  const engine = runtime.engine || new InputEngine({ log, ...current, ...(runtime.controlLease?{controlLease:runtime.controlLease}:{}), settingsFile: runtime.settingsFile || SETTINGS_FILE })
  const toolConfig = toolSpec()

  const tool = {
    ...toolConfig,
    async execute(args = {}, trustedContext = {}) {
      const request=(cmd,params,timeout)=>engine.request(cmd,cmd==='overlay'?{...params,preferredMonitor:current.preferredMonitor}:params,timeout,{caption:typeof trustedContext.caption === "string" ? trustedContext.caption.slice(0,180) : "会话名称暂不可用"})
      const action = String(args.action || 'status').toLowerCase()
      try {
        if (!current.enabled) {
          return toLosslessJson({
            text: '独立输入已关闭：请到 设置 → 独立输入 打开「启用独立输入」总开关。',
            meta: { ok: false, enabled: false },
          })
        }
        const contractBlock=keyboardContractBlock(action,args)
        if(contractBlock)return toLosslessJson({text:contractBlock.note,meta:contractBlock})
        const focusBlock=focusPolicyBlock(action,args,current.focusPolicy)
        if(focusBlock) {
          // A policy rejection must not hide an existing stop/finished state.
          const state=await request('status',{},10000)
          if(state?.ok===false) return toLosslessJson({text:resultText('status',state),meta:state})
          if(typeof state?.paused!=='boolean' || !['idle','active','finished'].includes(state.sessionState)) throw new Error('无法确认executor暂停/会话状态；未派发provider输入')
          if(state.sessionState==='finished') return toLosslessJson({text:'本次操作已finish；未派发provider输入。需显式begin，begin不能清除暂停。',meta:{ok:false,reason:'session-finished',paused:state.paused,sessionState:state.sessionState}})
          if(state.paused) return toLosslessJson({text:'executor已暂停；未派发本次provider输入，不自动resume。',meta:{ok:false,reason:'paused',paused:true,pauseReason:state.pauseReason,sessionState:state.sessionState}})
          return toLosslessJson({text:focusBlock.note,meta:focusBlock})
        }
        if ((action === 'click' || action === 'scroll' || action === 'drag' || action === 'type' || action === 'key')
          && String(args.mode || '').toLowerCase() === 'physical') {
          return toLosslessJson({
            text: '严格禁止 physical：鼠标会动真实光标，键盘会抢焦点。请用 mode:"auto"（已支持的目标 hwnd 后台消息；未知目标报告不支持）。',
            meta: { ok: false, strictNoRealMouse: true, strictNoFocusSteal: true, reason: 'physical-forbidden' },
          })
        }
        if (action === 'status') {
          const s = await request('status', {details:args.details===true}, 10000)
          s.control=await engine.control.status(trustedContext.threadId)
          if(s.control.pauseReason){s.paused=true;s.pauseReason=s.control.pauseReason;s.stopInfo=s.control.stopInfo||{reason:s.control.pauseReason,source:'unknown',utcTimestamp:null}}
          s.preferredMonitor = resolvePreferredMonitor(s.monitors, current.preferredMonitor)
          return toLosslessJson({ text: statusText(presentStatus(s,args.maxTextChars,args.details===true)), meta: presentStatus(s,args.maxTextChars,args.details===true) })
        }
        if (action === 'begin' || action === 'finish') {
          const state = presentStatus(await request(action, {}, 10000),args.maxTextChars)
          state.control=await engine.control.status(trustedContext.threadId)
          return toLosslessJson({ text: `${state.ok===false ? '操作未完成；控制权未释放。' : action === 'finish' ? '本次操作已收尾，后续输入须begin；暂停不会被清除。' : '操作会话已开始；若已暂停仍须用户明确继续。'}\n${statusText(state)}`, meta: state })
        }
        if (action === 'place') {
          const r = await placeWindow({request},args.hwnd,args.monitor || current.preferredMonitor)
          return toLosslessJson({text:r.ok === false ? resultText(action,r) : '已请求目标窗口置于偏好屏；按实际rect重新observe，不保证应用不自行激活。',meta:r})
        }
        if (action === 'open') {
          if(typeof args.path !== 'string' || !/^[A-Za-z]:[\\/]/.test(args.path)) throw new Error('open仅支持本地绝对文件/文件夹路径，不支持URI、UNC或任意shell命令')
          const path = await realpath(args.path)
          if(!/^[A-Za-z]:[\\/]/.test(path)) throw new Error('open目标必须解析到本地驱动器路径')
          const item = await stat(path)
          if(!item.isFile() && !item.isDirectory()) throw new Error('open目标不是普通文件或文件夹')
          const r=await openOnMonitor({request},path,args.monitor || current.preferredMonitor)
          return toLosslessJson({text:r.opened ? `已请求打开；${r.placementConfirmed ? '仅核对当前唯一新增顶层窗完整落在目标屏；仍须fresh观察主窗和文件内容（可能为启动器/闪屏）。' : '放置未确认，请观察候选窗口，不自动重新打开。'} 不激活/显示器仅是系统请求，前后焦点采样不是全程无失焦证明。` : resultText(action,r),meta:r})
        }
        if (action === 'bounds') {
          const r = await request('bounds', { hwnd: args.hwnd, x: args.x, y: args.y, width: args.width, height: args.height }, 10000)
          return toLosslessJson({ text: r.ok === false ? resultText(action, r) : '指定窗口bounds已请求更新；请按返回的实际rect重新observe。', meta: r })
        }
        if (action === 'observe') {
          const observed = await request('observe', { hwnd: args.hwnd, maxElements: args.maxElements }, 30000)
          if (observed.ok === false) return toLosslessJson({ text: resultText(action, observed), meta: observed })
          let screenshot = null
          if (args.includeScreenshot) {
            screenshot = await capture(ctx, engine, { hwnd: args.hwnd, path: args.path }, runtime.shotsDir)
            if (screenshot.meta?.ok === false) return toLosslessJson({ text: screenshot.text, meta: { ...screenshot.meta, observationId: observed.observationId } })
            const checked = await request('checkObservation', { hwnd: args.hwnd, observationId: observed.observationId }, 10000)
            if (checked.ok === false) return toLosslessJson({ text: '截图期间窗口几何发生变化；fresh observe后再动作。', meta: checked })
          }
          const presented=presentObservation(observed,args,screenshot)
          return toLosslessJson({ text: `观察 ${observed.observationId}：${observed.elements?.length || 0} 个UIA元素。${observationEvidenceNote(presented.evidence)}`, images: screenshot?.images || [], meta: { ...presented, screenshot: screenshot?.meta } })
        }
        if (action === 'windows') {
          const r = await request('windows', {}, 15000)
          r.preferredMonitor = resolvePreferredMonitor(r.monitors, current.preferredMonitor)
          const page=presentWindows(r,args)
          return toLosslessJson({ text: `窗口 ${page.windows.length}/${page.totalMatched}，offset=${page.offset}；${page.hasMore ? '还有后续页。' : '本次筛选已列完。'}`, meta: page })
        }
        if (action === 'pause') {
          const s = presentStatus(await request('pause', {}, 10000),args.maxTextChars)
          return toLosslessJson({ text: `已暂停。\n${statusText(s)}`, meta: s })
        }
        if (action === 'resume') {
          const s = presentStatus(await request('resume', {}, 10000),args.maxTextChars)
          return toLosslessJson({ text: `已恢复。\n${statusText(s)}`, meta: s })
        }
        if (action === 'move') {
          const r = await request('move', { x: args.x, y: args.y }, 10000)
          const meta = { ...r, cursorMode: engine.cursorMode, cursorSize: engine.cursorSize, cursorState: engine.cursorState }
          return toLosslessJson({ text: resultText('move', meta), meta })
        }
        if (action === 'overlay') {
          const hasConfig=args.cursorMode!==undefined||args.cursorSize!==undefined||args.cursorState!==undefined
          const showing=args.show!==false&&(args.show===true||(Number.isFinite(args.x)&&Number.isFinite(args.y))||!hasConfig)
          if(args.cursorState!==undefined&&!STYLE_IDS.includes(args.cursorState))throw new Error('未知cursorState')
          if(args.cursorState!==undefined)await engine.setCursorState(args.cursorState,showing)
          let modeResult = null
          let sizeResult = null
          if (args.cursorMode) {
            if (args.cursorMode !== 'clean' && args.cursorMode !== 'companion') {
              throw new Error('cursorMode 只能是 clean 或 companion')
            }
            modeResult = await engine.setCursorMode(args.cursorMode,undefined,showing)
          }
          if (args.cursorSize !== undefined) {
            sizeResult = await engine.setCursorSize(args.cursorSize,showing)
          }
          const mode = modeResult?.cursorMode || engine.cursorMode
          const size = sizeResult?.cursorSize ?? engine.cursorSize
          if (args.show === false) {
            const r = await request('overlay', { show: false }, 10000)
            return toLosslessJson({ text: resultText('overlay', { ...r, cursorMode: mode, cursorSize: size, cursorState: engine.cursorState }), meta: { ...modeResult, ...sizeResult, ...r, cursorMode:mode,cursorSize:size,cursorState:engine.cursorState } })
          }
          if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
            const r = await request('overlay', { show: true, x: args.x, y: args.y, cursorMode:mode,cursorSize:size,cursorState:engine.cursorState }, 10000)
            return toLosslessJson({ text: resultText('overlay', { ...r, cursorMode: mode, cursorSize: size, cursorState: engine.cursorState }), meta: { ...modeResult, ...sizeResult, ...r, cursorMode:mode,cursorSize:size,cursorState:engine.cursorState } })
          }
          if (!showing && (modeResult || sizeResult || args.cursorState!==undefined)) {
            const modeZh = mode === 'clean'
              ? `整洁模式：动作后约 ${modeResult?.cursorHoldMs || engine.cursorHoldMs}ms 自动收起`
              : '陪伴模式：一直显示到收工'
            return toLosslessJson({
              text: `AI 光标已切换：${modeZh} · ${size === 0 ? '系统大小×1.5625' : size + 'px'}。`,
              meta: { ...(modeResult || {}), ...(sizeResult || {}), cursorMode: mode, cursorSize: size, cursorState: engine.cursorState, ok: true },
            })
          }
          const r = await request('overlay', { show: true,cursorMode:mode,cursorSize:size,cursorState:engine.cursorState }, 10000)
          return toLosslessJson({ text: resultText('overlay', { ...r, cursorMode: mode, cursorSize: size, cursorState: engine.cursorState }), meta: { ...r, cursorMode: mode, cursorSize: size, cursorState: engine.cursorState } })
        }
        if (action === 'click') {
          const r = await request('click', { windowObservationId: args.windowObservationId,
            x: args.x, y: args.y, button: args.button, count: args.count, mode: args.mode, hwnd: args.hwnd,
            observationId: args.observationId, elementId: args.elementId,
          }, 30000)
          return toLosslessJson({ text: resultText('click', r), meta: r })
        }
        if (action === 'type') {
          const r = await request('type', { windowObservationId: args.windowObservationId,
            x: args.x, y: args.y, text: args.text, replace: args.replace,
            mode: args.mode, hwnd: args.hwnd,
            observationId: args.observationId, elementId: args.elementId,
          }, 60000)
          return toLosslessJson({ text: resultText('type', r), meta: r })
        }
        if (action === 'key') {
          const r = await request('key', { windowObservationId: args.windowObservationId,
            keys: args.keys, mode: args.mode, hwnd: args.hwnd, x:args.x, y:args.y,
          }, 30000)
          return toLosslessJson({ text: resultText('key', r), meta: r })
        }
        if (action === 'scroll') {
          const r = await request('scroll', { windowObservationId: args.windowObservationId,
            x: args.x, y: args.y, delta: args.delta, mode: args.mode, hwnd: args.hwnd,
          }, 30000)
          return toLosslessJson({ text: resultText('scroll', r), meta: r })
        }
        if (action === 'drag') {
          const r = await request('drag', { windowObservationId: args.windowObservationId,
            x: args.x, y: args.y, toX: args.toX, toY: args.toY,
            durationMs: args.durationMs, mode: args.mode, hwnd: args.hwnd,
          }, 90000)
          return toLosslessJson({ text: resultText('drag', r), meta: r })
        }
        if (action === 'capture') {
          return await capture(ctx, engine, args, runtime.shotsDir)
        }
        return {
          text: '未知action；查看independent_input schema的action枚举。',
          meta: { ok: false, action, reason: 'unknown-action' },
        }
      } catch (error) {
        return toLosslessJson({
          text: `独立输入没完成：${error?.message || error}`,
          meta: { ok: false, action, reason: error.code || 'executor-error', partial: error.partial || null, ...(error.control?{control:error.control}:{}) },
        })
      }
    },
  }

  const execute=tool.execute
  tool.execute=async(args={},context={},options={})=>{
    const trusted=await threadCaption(context)
    const withReminder=async result=>{
      if(trusted.threadId){try {const notice=await engine.control.claimReminder(trusted);if(notice){result.text+='\n'+notice.text;result.meta={...result.meta,controlReminder:notice}}}catch(error){log('排队提醒状态暂不可用：'+error.message)}}
      return result
    }
    const requestContext={...trusted,abortSignal:options.signal}
    const checkCancelled=()=>engine.checkRequestCancelled?.(requestContext)
    return engine.context.run(requestContext,async()=>{
      const action=String(args.action||'status').toLowerCase()
      if(['control_request','control_wait','control_cancel'].includes(action)){
        if(!current.enabled&&action!=='control_cancel')return toLosslessJson({text:'独立输入总开关已关闭；未排队或续等。',meta:{ok:false,enabled:false,reason:'disabled'}})
        try {
          const control=action==='control_wait'?await engine.control.wait(trusted,{waitMs:args.waitMs,signal:options.signal}):action==='control_cancel'?await engine.control.cancel(trusted):await engine.control.request(trusted,{signal:options.signal})
          return withReminder(toLosslessJson({text:control.turn==='ready'?'轮到你；先fresh观察，再begin获取控制权。':`控制队列：${control.turn} · 位置=${control.position} · ${control.waitResult||''}`,meta:{ok:true,control:presentControl(control,args.details===true)}}))
        }catch(error){return toLosslessJson({text:error.message,meta:{ok:false,reason:options.signal?.aborted?'control-wait-cancelled':error.code||'control-error'}})}
      }
      if(current.enabled && ['begin','finish','move','overlay','pause','resume','click','type','key','scroll','drag','bounds','place','open'].includes(action)){
        try {checkCancelled();await engine.control.acquire(trusted,['resume','begin'].includes(action)?action:null);checkCancelled()}catch(error){return toLosslessJson({text:error.message,meta:{ok:false,reason:error.code,control:presentControl(error.control||await engine.control.status(trusted.threadId),args.details===true)}})}
      }
      return withReminder(await execute(args,trusted))
    })
  }
  const dispose = ctx.tools.register(defineTool(tool))

  const applySettings = async (next) => {
    if (!next.enabled) {
      engine.stop(false)
      return
    }
    await engine.setCursorSize(next.cursorSize,true)
    await engine.setCursorMode(next.cursorMode, next.cursorHoldMs,true)
  }

  const previewContext=engine.control.manualPreviewContext()
  const previewId=engine.control.executionId(previewContext)
  const API_PREFIX = '/dsh-independent-input/api'
  const ASSET_PREFIX = '/dsh-independent-input/assets'

  const apiHandler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    try {
      if (req.method === 'GET' && route === '/settings') {
        return json(res, 200, { ok: true, settings: current })
      }
      if (req.method === 'POST' && route === '/settings') {
        const body = await readBody(req)
        const nextSettings = normalizeSettings(body, current)
        await applySettings(nextSettings)
        await persistSettings(nextSettings, runtime.settingsFile || SETTINGS_FILE)
        current = nextSettings
        return json(res, 200, { ok: true, settings: current })
      }
      if (req.method === 'POST' && route === '/hide') {
        if (!current.enabled) return json(res, 200, { ok: true, enabled: false })
        if(engine.control.owner?.executionId!==previewId)return json(res,409,{ok:false,reason:'preview-not-owner',control:await engine.control.status(previewId)})
        const result=await engine.context.run(previewContext,async()=>{await engine.request('overlay',{show:false});return engine.request('finish',{},10000)})
        return json(res,result.ok===false?409:200,result)
      }
      if(req.method==='POST' && route==='/resume-preview') {
        const state=await engine.control.status(previewId)
        if(state.ownerExecutionId!==previewId)return json(res,409,{ok:false,reason:'preview-not-owner',control:state})
        await engine.control.acquire(previewContext,'resume')
        const result=await engine.context.run(previewContext,()=>engine.request('resume',{},10000))
        return json(res,result.paused?409:200,result)
      }
      if (req.method === 'POST' && route === '/show') {
        if (!current.enabled) return json(res, 409, { ok: false, error: '独立输入已关闭，先在设置里启用总开关。' })
        await engine.control.acquire(previewContext)
        const result=await engine.context.run(previewContext,async()=>{await engine.request('begin',{},10000);return engine.request('overlay',{show:true,preferredMonitor:current.preferredMonitor,cursorMode:engine.cursorMode,cursorSize:engine.cursorSize,cursorState:engine.cursorState},30000)})
        return json(res,result.ok===false?409:200,{...result,control:await engine.control.status(previewId)})
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      log(`http ${req.method} ${route}: ${error?.message || error}`)
      return json(res,error.code==='control-busy'?409:500,{ok:false,error:String(error?.message||error),reason:error.code||'executor-error',...(error.control?{control:error.control}:{})})
    }
  }

  const assetHandler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(ASSET_PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    try {
      const name = url.pathname.slice(ASSET_PREFIX.length).replace(/^\//, '').replace(/\.png$/i, '').toLowerCase()
      if (!STYLE_IDS.includes(name)) return json(res, 404, { ok: false, error: 'unknown style' })
      const buffer = await readFile(join(PREVIEW_DIR, `${name}.png`))
      res.statusCode = 200
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.setHeader('content-length', buffer.length)
      return res.end(buffer)
    } catch (error) {
      log(`asset ${url.pathname}: ${error?.message || error}`)
      return json(res, 404, { ok: false, error: 'not found' })
    }
  }

  try {
    if (ctx?.webServer && typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }), 'independent-input: api')
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ASSET_PREFIX, handler: assetHandler }), 'independent-input: assets')
    } else {
      log('webServer 不可用：设置页 API 没挂上')
    }
  } catch (error) {
    log(`设置页 API 挂载失败：${error?.message || error}`)
  }

  const disposeRuntime = () => {
    try { dispose?.() } catch { /* ignore */ }
    engine.control.disconnect?.().catch(()=>{})
    const owner=engine.control.owner?.executionId
    engine.stop().then(()=>{if(owner&&!engine.proc&&!engine.stopFailure)return engine.control.release(owner)}).catch(()=>{})
  }
  disposeRuntime.interrupt = reason => engine.interrupt(reason, { host: true })
  disposeRuntime.cancelRequest=context=>{
    if(context?.threadId&&engine.control.owner?.executionId===context.threadId)engine.interrupt('host-cancel',{host:true})
  }
  disposeRuntime.reminderDelivered=(context,leaseId)=>engine.control.delivered(context,leaseId)
  disposeRuntime.cancelQueuedTicket=context=>engine.control.cancel(context)
  return disposeRuntime
}

async function capture(ctx, engine, args, shotsDir = join(homedir(), '.dsh', 'independent-input', 'shots')) {
  let rect = typeof args.rect === 'string' ? args.rect.trim() : ''
  const screenCopy = Boolean(rect)
  let targetHwnd = args.hwnd
  if (rect.toLowerCase() === 'full' || rect === '0,0,0,0') rect = '0,0,0,0'
  if (!rect) {
    const status = args.hwnd ? null : await engine.request('status', {}, 10000)
    const hwnd = args.hwnd || status?.foreground?.hwnd
    targetHwnd = hwnd
    if (hwnd) {
      const info = await engine.request('winInfo', { hwnd }, 10000)
      const r = info?.rect
      if (r && r.w > 0 && r.h > 0) rect = `${r.x},${r.y},${r.w},${r.h}`
      else if (args.hwnd) throw new Error('目标窗口无有效截图区域；重新 windows 获取目标')
    }
    if (!rect) throw new Error('没有有效窗口目标；先windows选择hwnd，或明确指定rect/full进行屏幕采样。')
  }

  const path = args.path || join(shotsDir, `shot-${Date.now()}.png`)
  await mkdir(dirname(path), { recursive: true })
  const saved = await engine.request('capture', { path, rect, hwnd: targetHwnd, screenCopy }, 30000)
  if (saved.ok === false) return toLosslessJson({ text: resultText('capture', saved), meta: saved })

  let images = []
  try {
    const data = await readFile(path)
    const svc = ctx?.attachments
    if (svc?.saveImage) {
      const ref = await svc.saveImage.call(svc, {
        data,
        mediaType: 'image/png',
        name: `independent-input-${Date.now()}.png`,
      })
      images = [ref]
    }
  } catch (error) {
    ctx?.logger?.warn?.(`[independent-input] 截图读不回来：${error?.message || error}`)
  }

  return toLosslessJson({
    text: resultText('capture', { ok: true, path: saved.path, attached: images.length > 0 })+'\n映射/遮挡安全不验证业务内容fresh；查看实际图片确认当前场景。',
    images,
    meta: { ok: true, evidence:screenshotEvidence({images,path:saved.path}), path: saved.path, rect: saved.method === 'wgc-window' ? saved.rect : rect, screenshot: saved.rect || null, method: saved.method, sourceHwnd: saved.sourceHwnd, imageSize: saved.imageSize, mappingVerified: saved.mappingVerified === true, mappingSource: saved.mappingSource, occlusionSafe: saved.occlusionSafe === true, note: saved.note, coordinateSystem: saved.rect ? 'screen-physical-pixels' : 'unmapped-image-pixels', attached: images.length > 0 },
  })
}
