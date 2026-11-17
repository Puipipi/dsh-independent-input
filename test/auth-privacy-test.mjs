import assert from 'node:assert/strict'
import {apply} from '../index.js'
let tool;const secret='fixture-credential-123',url=`https://qa.test/auth/login?key=${secret}`
await apply({tools:{register(t){tool=t}},logger:{info(){}}},{enabled:true},{defineTool:t=>t,engine:{request:async()=>({ok:true,windows:[{hwnd:1,title:url}],foreground:{title:url}})}})
const result=await tool.execute({action:'windows'})
assert(!JSON.stringify(result).includes(secret),'upstream public windows result leaks authentication URL secret')
console.log('PASS upstream real registered tool result auth URL redacted')
