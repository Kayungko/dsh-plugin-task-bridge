# install.ps1 — 部署 dsh-plugin-task-bridge 到 DSH desktop profile。
#
# 策略照 dsh-plugin-task-coordinator 的 copy-based 安装：拷入 profile 的 hoisted
# node_modules（与 registry 安装的 bundle 同物理布局），不跑 pnpm、不动 lockfile
# 与市场托管版本。重启 DSH Desktop 后加载新 bundle。
#
# 本插件特有职责：首次安装生成随机 token 文件——32 随机字节 → 64 位十六进制
# （等价 node crypto.randomBytes(32).toString('hex')），已存在则绝不覆盖。
# token 是桥的唯一防线（exact 路由命中后零宿主鉴权），详见 README 安全节。
#
# 前置依赖：dsh-plugin-task-coordinator 需为「服务缝版本」（0.24.0+：provide 载
# 荷含 ops，且其插件组 isolate 与本桥同用共享 label 'dsh-task-bridge'）；否则桥
# 的全部端点恒回 503 upstream-error（桥本身仍正常挂载）。
#
# Usage:
#   pwsh install.ps1                                  # 安装到默认 profile
#   pwsh install.ps1 -TokenFile D:\path\token         # 自定义 token 路径（须与插件 config.tokenFile 一致）
#   pwsh install.ps1 -Uninstall                       # 卸载（保留 token 文件）

param(
  [string]$Source = $PSScriptRoot,
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$TokenFile = (Join-Path $env:USERPROFILE '.dsh\task-bridge-token'),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# 目标目录不可作为 cwd：Windows 拒绝删除某进程的工作目录。
Set-Location $PSScriptRoot
$PackageName = 'dsh-plugin-task-bridge'
$Target = Join-Path $Profile "node_modules\$PackageName"
$ManifestPath = Join-Path $Profile 'package.json'
$PackageMapPath = Join-Path $Profile 'node_modules\.package-map.json'

function Read-Json([string]$path) { return (Get-Content $path -Raw) | ConvertFrom-Json -Depth 64 }
function Write-Json([string]$path, $obj) { Set-Content -Path $path -Value ($obj | ConvertTo-Json -Depth 64) -Encoding utf8 }

# --- backups -----------------------------------------------------------------
$BackupDir = Join-Path $PSScriptRoot "backups\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
if (Test-Path $ManifestPath) { Copy-Item $ManifestPath (Join-Path $BackupDir 'profile-package.json') }
if (Test-Path $PackageMapPath) { Copy-Item $PackageMapPath (Join-Path $BackupDir 'package-map.json') }
Write-Host "backup -> $BackupDir"

# --- uninstall ---------------------------------------------------------------
if ($Uninstall) {
  if (Test-Path $ManifestPath) {
    $manifest = Read-Json $ManifestPath
    $bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $PackageName })
    $manifest.dsh.profile.bundles = $bundles
    if ($manifest.PSObject.Properties['dependencies']) {
      $manifest.dependencies.PSObject.Properties.Remove($PackageName)
    }
    Write-Json $ManifestPath $manifest
  }
  if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
  Write-Host "uninstalled $PackageName (restart DSH Desktop to apply; token file kept: $TokenFile)"
  exit 0
}

# --- sanity checks -----------------------------------------------------------
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "plugin source not found: $Source" }
if (-not (Test-Path (Join-Path $Source 'index.mjs'))) { throw "plugin entry index.mjs not found in: $Source" }
if (-not (Test-Path $ManifestPath)) { throw "profile manifest not found: $ManifestPath" }

# --- copy plugin files（原地覆写；删目录会因「是某进程 cwd」而失败，覆写不会）---
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Force -Path $Target | Out-Null }
$files = @(
  'package.json', 'cordis.patch.yml', 'index.mjs', 'auth.mjs', 'policy.mjs',
  'endpoints.mjs', 'smoke.mjs', 'verify-installed.mjs', 'README.md', 'CHANGELOG.md'
)
foreach ($file in $files) {
  $from = Join-Path $Source $file
  if (Test-Path $from) { Copy-Item $from (Join-Path $Target $file) -Force }
}
Write-Host "copied plugin -> $Target"

# --- profile manifest：依赖 specifier + bundle 条目 ---------------------------
$manifest = Read-Json $ManifestPath
if (-not $manifest.PSObject.Properties['dependencies']) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([PSCustomObject]@{})
}
$manifest.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue "file:$($Source -replace '\\', '/')" -Force
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains $PackageName) { $bundles += $PackageName }
$manifest.dsh.profile.bundles = $bundles
Write-Json $ManifestPath $manifest
Write-Host 'profile manifest updated (dependencies + bundles)'

# --- pnpm bookkeeping（.package-map.json，只增不删）--------------------------
if (Test-Path $PackageMapPath) {
  $map = Read-Json $PackageMapPath
  if ($map.PSObject.Properties['packages'] -and -not $map.packages.PSObject.Properties[$PackageName]) {
    $entry = [PSCustomObject]@{
      url          = "./$PackageName"
      dependencies = [PSCustomObject]@{ $PackageName = $PackageName }
    }
    $map.packages | Add-Member -NotePropertyName $PackageName -NotePropertyValue $entry
    if ($map.packages.PSObject.Properties['.']) {
      $root = $map.packages.'.'
      if ($root.PSObject.Properties['dependencies']) {
        $root.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $PackageName -Force
      }
    }
    Write-Json $PackageMapPath $map
    Write-Host '.package-map.json updated'
  }
}

# --- token 文件：首装生成，已存在不覆盖（固定契约①）-------------------------
if (Test-Path $TokenFile) {
  Write-Host "token file exists, kept untouched: $TokenFile"
} else {
  $tokenDir = Split-Path $TokenFile -Parent
  if (-not (Test-Path $tokenDir)) { New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null }
  # 32 随机字节 → 64 位小写十六进制（等价 crypto.randomBytes(32).toString('hex')）
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Set-Content -Path $TokenFile -Value $token -NoNewline -Encoding ascii
  # 尽力收紧 ACL：禁用继承 + 仅当前用户完全控制（失败仅告警，不阻断安装）。
  try {
    $acl = Get-Acl -Path $TokenFile
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule($rule)
    Set-Acl -Path $TokenFile -AclObject $acl
    Write-Host "token generated (64 hex chars from 32 random bytes; ACL: current user only): $TokenFile"
  } catch {
    Write-Warning "token generated but ACL tightening failed: $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host 'done. Restart DSH Desktop to load the bridge.'
Write-Host 'After restart (with the 0.24.0+ service-seam coordinator installed), endpoints live at:'
Write-Host '  http://127.0.0.1:43120/v1/{spawn,send,progress,wait,list,models}   (header: X-Task-Bridge-Token)'
Write-Host "Token file: $TokenFile  (rotate by overwriting it — hot-reloaded, no restart; see README 安全节)"
