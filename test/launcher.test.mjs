/**
 * launcher.test.mjs — 启动器（dcm.bat / dcm.sh）回归测试。
 *
 * 起因：2026-10-04 用户报告「dcm.bat 开不了 webui」，实测出三个真缺陷——
 *   1. `serve` 命令直接调 startServer，端口被占时 EADDRINUSE 抛未捕获栈；
 *      双击的窗口一闪而过，用户只看到「开不了」。
 *   2. `dcm.bat` 存为 UTF-8 **无 BOM**，cmd.exe 按 OEM(936/GBK) 解析中文，
 *      注释被错解成命令（实测把 `1) Make sure...` 里的文本当成 dsh 的参数）。
 *   3. `dcm.bat` 双击分支没有 `pause`，出错时窗口立刻消失。
 *   另外 `echo   1) ...` 的裸 `)` 会让 cmd 报 "unexpected at this time"。
 *
 * 这些都不是逻辑 bug 而是**载体 bug**，单测容易漏，所以这里显式钉住。
 *
 * 用法：node test/launcher.test.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
function section(t) { console.log(`\n== ${t} ==`) }

const batPath = join(ROOT, 'dcm.bat')
const shPath = join(ROOT, 'dcm.sh')

// ── dcm.bat：编码与语法 ──────────────────────────────────────────────────

section('dcm.bat 编码（cmd.exe 按 OEM 代码页解析）')

{
  const bytes = readFileSync(batPath)
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  // 无 BOM 时中文注释会按 GBK 错解，实测导致命令被拆成碎片执行。
  check('带 UTF-8 BOM', hasBom,
    '缺 BOM 时 cmd.exe 按代码页(936/GBK) 解析，中文注释错解成命令')

  const text = readFileSync(batPath, 'utf8')
  check('使用 CRLF 换行', text.includes('\r\n'), 'cmd.exe 需要 CRLF')
  check('无中文内容（不依赖代码页）',
    !/[一-鿿]/.test(text.replace(/^\uFEFF/, '')),
    '保留中文会让 BOM 一旦丢失就再次错解')
}

section('dcm.bat cmd 语法陷阱')

{
  const text = readFileSync(batPath, 'utf8')
  const lines = text.split(/\r?\n/)

  // echo 后的裸 ) 或 ( 会让 cmd 报 "X was unexpected at this time"。
  // 引号内的括号是安全的（`echo "1) text"`），要先剥掉引号内容再判。
  const badEcho = lines.filter((l) => {
    if (!/^\s*echo\b/.test(l)) return false
    const rest = l.replace(/^\s*echo\s*/, '')
    const unquoted = rest.replace(/"[^"]*"/g, '')
    return /[()]/.test(unquoted)
  })
  check('echo 行不含裸括号', badEcho.length === 0, badEcho.join(' | '))

  // 双击分支必须有 pause，否则出错时窗口一闪而过。
  // 注意不能用 `errorlevel 1 ... pause` 这样的连续正则：双击分支里
  // errorlevel 判断自身带一个嵌套块，pause 在嵌套块内部。
  // 定位要精确：文件里还有 `if not "%~1"=="" chcp ...` 这种同样含该模式
  // 的行，真正的分支是**不带 `not`**、且行尾紧跟 `(` 的那行。
  const dblIdx = lines.findIndex((l) => /^\s*if\s+"%~1"==""\s*\(\s*$/.test(l))
  check('存在双击分支', dblIdx >= 0, `未找到 /if "%~1"=="" ($/, 现有行: ${lines.map((l, i) => /%~1/.test(l) ? `${i}:${l.trim()}` : null).filter(Boolean).join(' | ')}`)
  // 取到配对的右括号（按括号配平找分支结束）
  let depth = 0
  let end = dblIdx
  for (let i = dblIdx; i < lines.length; i++) {
    depth += (lines[i].match(/\(/g) ?? []).length
    depth -= (lines[i].match(/\)/g) ?? []).length
    if (depth <= 0 && i > dblIdx) { end = i; break }
  }
  const branch = lines.slice(dblIdx, end + 1)
  const errIdx = branch.findIndex((l) => /errorlevel\s+1/i.test(l))
  check('双击分支有 errorlevel 判断', errIdx >= 0)
  check('双击分支出错时 pause',
    errIdx >= 0 && branch.slice(errIdx).some((l) => /^\s*pause\s*$/i.test(l)),
    '没有 pause 时窗口会立刻关闭，用户看不到任何错误')

  // 设置 chcp，让后续输出不因代码页错乱
  check('设置 chcp 65001', /chcp\s+65001/i.test(text))
}

section('dcm.bat 实际可解析')

{
  // 让 cmd 真正跑一遍：`status` 是无副作用的只读子命令，
  // 既证明脚本能解析执行，又不会启动服务器或改任何文件。
  let out = ''
  let ok = false
  try {
    out = execFileSync('cmd.exe', ['/c', batPath, 'status'], { encoding: 'utf8', timeout: 30000 })
    ok = true
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const noisy = /was unexpected at this time|is not recognized as an internal|syntax error/i.test(out)
  check('cmd.exe 解析无语法错误', !noisy, out.split('\n').slice(0, 3).join(' | '))
  check('确实执行到了程序（status 输出了 profile）', ok && /profile:/i.test(out), out.split('\n')[0] ?? '')
  check('没有误调用 PATH 里的其它程序', !/dsh-app-boot|profile .* does not exist/i.test(out))
}

// ── dcm.sh ──────────────────────────────────────────────────────────────

section('dcm.sh')

{
  check('存在', existsSync(shPath))
  const text = readFileSync(shPath, 'utf8')
  check('使用 LF 换行', text.includes('\n') && !text.includes('\r\n'), 'shell 脚本应为 LF')
  check('有可执行位调用 node', /exec\s+"\$NODE"/.test(text))
  check('node 探测失败时给提示', /找不到 node|exit 1/.test(text))
  check('不写死用户路径', !/C:\\Users\\/.test(text))
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)