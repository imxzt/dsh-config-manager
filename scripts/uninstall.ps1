#Requires -Version 5.1
<#
.SYNOPSIS
  从 DSH profile 卸载 dsh-config-manager（幂等）。

.DESCRIPTION
  **顺序是这条命令的全部意义**——2026-10-03 的 profile 重置事故就是顺序错了：

    1. 先从 dsh.profile.bundles 摘掉声明
    2. 再从 dependencies 摘掉
    3. 最后删目录联接

  反过来做（先删包、后改清单）会让「bundles 声明了但磁盘没有」这个状态
  存在一段时间，只要此时 DSH 启动，resolveBundleDir() 就抛错，DSH 随即把
  整个 profile 重置成模板 —— 19 个插件配置静默丢失。

  本脚本还刻意**不碰其它依赖、不跑 pnpm**：pnpm 会连带改动依赖树。

.PARAMETER Profile
  profile 名。缺省 $env:DSH_PROFILE，否则 desktop。

.PARAMETER DshHome
  Harness home。缺省 $env:DSH_HOME，否则 ~/.dsh。

.PARAMETER KeepData
  保留 undo/ 与 stateDir 下的数据（默认保留，删除需显式 -RemoveData）。
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

$PKG = 'dsh-config-manager'
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path (Join-Path $profileDir 'node_modules') $PKG
$stateDir = Join-Path $DshHome "plugins\$PKG"

Write-Host "== dsh-config-manager uninstall =="
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到: $manifestPath" }

# 找 node：优先 DSH 内置运行时，其次 PATH（不写死运行时目录名）。
function Find-Node([string]$Home) {
  $runtimes = Join-Path $Home 'dsh-runtimes'
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

# 0. 卸载前还原点
$node = Find-Node $DshHome
$dcm = Join-Path $stateDir 'bin\dcm.mjs'
if ($node -and (Test-Path -LiteralPath $dcm)) {
  Write-Host "  建还原点…"
  & $node $dcm save "pre-uninstall: $PKG" --profile $Profile --home $DshHome | Out-Null
}

$raw = [System.IO.File]::ReadAllText($manifestPath)
$manifest = $raw | ConvertFrom-Json

# 1. **先摘 bundles**（关键顺序）
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -contains $PKG) {
  $manifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $PKG })
  Write-Host "  已从 bundles 摘除"
} else {
  Write-Host "  bundles 中无此项"
}

# 2. 再摘 dependencies
if ($manifest.dependencies.PSObject.Properties.Name -contains $PKG) {
  $manifest.dependencies.PSObject.Properties.Remove($PKG)
  Write-Host "  已从 dependencies 摘除"
} else {
  Write-Host "  dependencies 中无此项"
}

$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  manifest 已写入"

# 3. 最后删联接
# 用 .NET 的 Directory.Delete（只删链接本体）：
#  - PowerShell 5.1 的 Remove-Item 删 junction 会抛 NullReferenceException；
#  - 带 -Recurse 时会跟进联接删除**源目录真实文件**（严重数据风险）。
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.LinkType -eq 'Junction') {
    [System.IO.Directory]::Delete($linkPath, $false)
    if (Test-Path -LiteralPath $linkPath) {
      Write-Warning "  联接删除失败，仍在: $linkPath"
    } else {
      Write-Host "  联接已删除（源目录未受影响）"
    }
  } else {
    Write-Warning "  路径不是联接而是实体目录，保留不动以免误删：$linkPath"
  }
} else {
  Write-Host "  联接不存在"
}

# 4. 卸载后校验
Write-Host ""
Write-Host "== 卸载后校验 =="
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $dcm)) {
  & $node $dcm preflight --profile $Profile --home $DshHome
  if ($LASTEXITCODE -ne 0) { Write-Warning "预检未通过，不要重启 DSH。" ; exit 1 }
}

if ($RemoveData) {
  if (Test-Path -LiteralPath $stateDir) {
    Remove-Item -LiteralPath $stateDir -Recurse -Force
    Write-Host "  已删除数据目录: $stateDir"
  }
} else {
  Write-Host "  数据保留在: $stateDir（加 -RemoveData 才删除）"
}

Write-Host ""
Write-Host "卸载完成。重启 DSH 后侧栏入口消失。"
Write-Host "注意: 外部 UI 是独立入口，不受本卸载影响，仍可用 dcm.bat 启动。"