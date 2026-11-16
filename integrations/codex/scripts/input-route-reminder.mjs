#!/usr/bin/env node
// Stateless conditional default, not permission or a tool interceptor.
const context = '[Windows桌面默认后端] 若本轮确需已获用户授权的Windows桌面动作，默认使用独立输入插件 server independent-input / tool independent_input，不静默回退原生Computer Use。用户后续明确改选时尊重最新要求；浏览器及专门连接器仍按任务适用性选择。提及、引用、历史、状态问答或本提示本身都不授予输入权限。先windows选唯一hwnd，再observe→一个动作→再observe；ID/状态stale则fresh observe后仅重试原动作一次，普通键鼠活动不是硬stop。active时真实Esc/pause锁暂停，用户明确继续才resume；完整操作结束用finish，不能把每个toolcall当结束。宿主stopped/ended/权限拒绝立即停，begin不能绕过暂停。工具不可见时准确报告并使用正式宿主刷新；仅在宿主允许且用户批准时接入持久标准MCP入口，不包装模块绕过受限REPL、不新建call-once输入client。有副屏优先副屏，但不因此拒绝主屏已授权目标收尾或擅自搬用户已有窗口；按实际preferredMonitor/workArea与bounds能力操作，不承诺双前台或应用绝不自行激活。先看status.control；本插件同用户桌面控制锁busy时按owner等待，不另开client抢占；官方CU状态unknown、旧版backend不受新锁覆盖。busy时control_request/control_wait挂起等待，每次≤45秒到期续wait，不因等待Final；同一原CU子代理可等待并以父子通道报告主会话，ready后fresh观察再begin；用户stop撤自己票，不新建聊天或后台模型。保持唯一已授权电脑执行器。这是软提示，不授权、不热加载工具、不强制模型服从，不启动输入。'
let output = {}
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (input?.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string') {
    output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }
  }
} catch { /* Missing/invalid hook payload is a no-op, never an authorization. */ }
process.stdout.write(JSON.stringify(output) + '\n')
