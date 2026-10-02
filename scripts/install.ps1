#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-config-manager 装进 DSH profile 作为 selected bundle（幂等）。

.DESCRIPTION
  三个效果，全部可重复执行：

    1. 目录联接
         <DSH_HOME>\profiles\<profile>\node_modules\dsh-config-manager  ->  本包目录
    2. profile manifest 登记
         dependencies["dsh-config-manager"] = "file:<相对路径>"
         dsh.profile.bundles += "dsh-config-manager"
       作为 selected bundle 是它出现在 Plugins 页、且 boot 合并本包
       cordis.patch.yml 的前提。
    3. 打一个还原点（调用 dcm 自身），这样装完出问题可一键回退。

  **为什么用脚本而不是 pnpm add**：pnpm 会把 `file:` 依赖物化成实体副本，
  破坏「改源码即时生效」；而且它可能连带改动其它依赖（2026-10-03 事故就是
  pnpm 报告 `+1 -26` 连带删包导致 profile 被重置）。本脚本只建联接、只改
  manifest 的两个字段，不动 lockfile、不动其它依赖。

.PARAMETER Profile
  profile 名。缺省 $env:DSH_PROFILE，否则 desktop。

.PARAMETER DshHome
  Harness home。缺省 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER SkipSnapshot
  跳过安装前的还原点。
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$SkipSnapshot
)

$ErrorActionPreference = 'Stop'

$PKG = 'dsh-config-manager'
$pluginDir = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$nodeModules = Join-Path $profileDir 'node_modules'
$manifestPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $nodeModules $PKG

# 找 node：优先 DSH 内置运行时，其次 PATH。
# 不写死运行时目录名（`dsh-primary-runtime` 会随 DSH 版本变化）。
# 注意参数名不能用 $Home —— 那是 PowerShell 的只读自动变量，赋值会直接报错。
function Find-Node([string]$DshRoot) {
  $runtimes = Join-Path $DshRoot 'dsh-runtimes'
  if (Test-Path -LiteralPath $runtimes) {
    foreach ($d in Get-ChildItem -LiteralPath $runtimes -Directory -ErrorAction SilentlyContinue) {
      $cand = Join-Path $d.FullName 'dependencies\node\bin\node.exe'
      if (Test-Path -LiteralPath $cand) { return $cand }
    }
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

Write-Host "== dsh-config-manager install =="
Write-Host "  插件目录 : $pluginDir"
Write-Host "  profile  : $profileDir"

foreach ($required in @($profileDir, $manifestPath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "找不到: $required" }
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'lib\index.js'))) {
  throw "插件源码不完整: $pluginDir\lib\index.js 缺失"
}
if (-not (Test-Path -LiteralPath $nodeModules)) {
  New-Item -ItemType Directory -Path $nodeModules | Out-Null
}

$node = Find-Node $DshHome
$dcm = Join-Path $pluginDir 'bin\dcm.mjs'

# 0. 安装前还原点（用 dcm 自身，失败不阻断安装但会警告）
if (-not $SkipSnapshot) {
  if ($node -and (Test-Path -LiteralPath $dcm)) {
    Write-Host "  建还原点…"
    & $node $dcm save "pre-install: $PKG" --profile $Profile --home $DshHome | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning '还原点创建失败，继续安装。' }
  } else {
    Write-Warning "找不到 node 或 dcm，跳过还原点。"
  }
}

# 1. 建目录联接
# 删除联接用 .NET 的 Directory.Delete（只删链接本体）。
# PowerShell 5.1 的 Remove-Item 删 junction 会抛 NullReferenceException，
# 且带 -Recurse 时会跟进联接删除源目录真实文件——两者都要避开。
if (Test-Path -LiteralPath $linkPath) {
  $existing = Get-Item -LiteralPath $linkPath -Force
  if ($existing.LinkType -eq 'Junction') {
    if ($existing.Target -eq $pluginDir) {
      Write-Host "  联接已正确"
    } else {
      Write-Host "  替换联接: $($existing.Target) -> $pluginDir"
      [System.IO.Directory]::Delete($linkPath, $false)
      New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
    }
  } else {
    # 实体副本（pnpm 曾把它物化）：挪开而不是直接删，确认后再清。
    Write-Warning "  路径是实体目录而非联接，挪开重建"
    $aside = "$linkPath.aside-$([DateTime]::UtcNow.Ticks)"
    Rename-Item -LiteralPath $linkPath -NewName (Split-Path -Leaf $aside)
    New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
    if (Test-Path -LiteralPath (Join-Path $linkPath 'lib\index.js')) {
      Remove-Item -LiteralPath $aside -Recurse -Force
      Write-Host "  联接已重建，旧副本已清理"
    } else {
      throw "联接验证失败，副本保留在 $aside"
    }
  }
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
  Write-Host "  已建联接: $linkPath -> $pluginDir"
}

# 2. 登记 manifest（只改两个字段，用 JSON 解析而非文本替换）
$raw = [System.IO.File]::ReadAllText($manifestPath)
if ($raw.Length -ge 3 -and [int][char]$raw[0] -eq 0xEF) {
  throw "manifest 带 BOM，DSH 会在 JSON.parse 前中止。请先去掉 BOM。"
}
$manifest = $raw | ConvertFrom-Json

# 计算相对路径。
# 不能用 [System.IO.Path]::GetRelativePath —— 那是 .NET Core+ 的 API，
# Windows PowerShell 5.1（.NET Framework）没有这个方法。
function Get-RelativePath([string]$FromDir, [string]$ToPath) {
  $from = (Resolve-Path -LiteralPath $FromDir).Path.TrimEnd('\') + '\'
  $to = (Resolve-Path -LiteralPath $ToPath).Path
  $fromUri = New-Object System.Uri($from)
  $toUri = New-Object System.Uri($to)
  $rel = $fromUri.MakeRelativeUri($toUri).ToString()
  return [System.Uri]::UnescapeDataString($rel).Replace('/', '\')
}

$relative = Get-RelativePath $profileDir $pluginDir
$spec = "file:" + $relative.Replace('\', '/')

# 跨盘符时 Uri 相对路径会退化成带很多 `..` 的长串（指向错误位置）。
# 真实部署里 profile 与插件都在同一个 DSH_HOME 下，不该出现这种情况；
# 与其静默写一个错的 file: 说明，不如显式失败。
if ($relative -match '^[A-Za-z]:' -or ($relative -split '\\' | Where-Object { $_ -eq '..' }).Count -ge 4) {
  throw "无法为插件目录计算相对路径（profile 与插件可能不在同一盘符）：$relative"
}

if ($null -eq $manifest.dependencies) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
if ($manifest.dependencies.PSObject.Properties.Name -contains $PKG) {
  Write-Host "  依赖已登记: $($manifest.dependencies.$PKG)"
} else {
  $manifest.dependencies | Add-Member -NotePropertyName $PKG -NotePropertyValue $spec -Force
  Write-Host "  已登记依赖: $PKG = $spec"
}

if ($null -eq $manifest.dsh) { throw "manifest 缺少 dsh 字段" }
if ($null -eq $manifest.dsh.profile) { throw "manifest 缺少 dsh.profile 字段" }

$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -contains $PKG) {
  Write-Host "  已选中为 bundle"
} else {
  $bundles += $PKG
  $manifest.dsh.profile.bundles = $bundles
  Write-Host "  已加入 bundles（追加到末尾）"
}

# 写回：UTF-8 无 BOM，2 空格缩进（与 DSH 自身写法一致）
$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  manifest 已写入"

# 3. 安装后校验：**这一步是事故教训的直接固化**
Write-Host ""
Write-Host "== 安装后校验 =="
if ($node -and (Test-Path -LiteralPath $dcm)) {
  & $node $dcm preflight --profile $Profile --home $DshHome
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Warning "预检未通过 —— 不要重启 DSH！用下面的命令回退："
    Write-Host "  `"$node`" `"$dcm`" recover --yes --profile $Profile --home $DshHome"
    exit 1
  }
} else {
  Write-Warning "找不到内置 node，无法自动预检。请手动确认 bundles 每一项都可解析。"
}

Write-Host ""
Write-Host "安装完成。若 profile 启用了 HMR 会即时重组；否则重启 DSH 生效。"
Write-Host "外部 UI:  $pluginDir\dcm.bat"