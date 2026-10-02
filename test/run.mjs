/**
 * run.mjs — 跑全部自测。
 *
 * 用法：node test/run.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

let allOk = true
for (const f of files) {
  console.log(`\n${'='.repeat(60)}\n${f}\n${'='.repeat(60)}`)
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' })
  if (r.status !== 0) allOk = false
}

console.log(`\n${'='.repeat(60)}`)
console.log(allOk ? '全部测试通过' : '有测试失败')
process.exit(allOk ? 0 : 1)
