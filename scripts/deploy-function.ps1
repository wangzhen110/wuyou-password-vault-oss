# 云函数全自动部署：走微信开发者工具官方 cli.bat（无需在 IDE 内逐次点"允许"）。
# 用法：npm run deploy:function -- sync   （函数名作为参数）
# 前提：微信开发者工具已启动并打开本项目（服务端口开启、已登录）。
#
# 2026-10-18 加固：部署后自动「下载云端代码 + 归一化哈希比对」。
# 背景：vpay 曾出现部署返回 success、但云端实际是默认 Hello World 模板（CodeSize 286），
#       直到用户点支付才暴露。此校验把"部署假成功"挡在脚本出口。
param(
  [Parameter(Mandatory = $true)][string]$FunctionName,
  [string]$ProjectRoot = "",
  [string]$EnvId = "your-cloud-env-id",
  [switch]$SkipVerify = $false
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) {
  $ProjectRoot = [System.IO.Path]::GetDirectoryName($PSScriptRoot)
}
$candidates = @(
  "${env:ProgramFiles(x86)}\Tencent\微信web开发者工具\cli.bat",
  "$env:ProgramFiles\Tencent\微信web开发者工具\cli.bat"
)
$cli = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cli) {
  Write-Error "未找到微信开发者工具 CLI，已尝试: $($candidates -join '; ')"
  exit 1
}

$localIndex = Join-Path $ProjectRoot "cloudfunctions\$FunctionName\index.js"
if (-not (Test-Path $localIndex)) {
  Write-Error "本地函数入口不存在: $localIndex"
  exit 1
}

Write-Host "[deploy] 部署云函数 $FunctionName -> $EnvId (cli: $cli)"
& $cli cloud functions deploy -e $EnvId -n $FunctionName --project $ProjectRoot -r
if ($LASTEXITCODE -ne 0) {
  Write-Error "部署失败（exit $LASTEXITCODE）"
  exit $LASTEXITCODE
}
Write-Host "[deploy] $FunctionName 部署命令返回成功，开始校验云端代码…"

if ($SkipVerify) {
  Write-Warning "[verify] 已跳过代码校验（-SkipVerify）"
  exit 0
}

# ---- 归一化：去 BOM、统一换行、去行尾空白，再算 sha256 ----
function Get-NormalizedHash([string]$Path) {
  $text = Get-Content -Raw -LiteralPath $Path -Encoding UTF8
  if ($null -eq $text) { $text = "" }
  $text = $text -replace "^\uFEFF", ""
  $text = $text -replace "`r`n", "`n"
  $text = $text -replace "`r", "`n"
  $lines = $text -split "`n" | ForEach-Object { $_.TrimEnd() }
  $norm = ($lines -join "`n")
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($norm)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
}

$tmp = Join-Path $env:TEMP ("fn-verify-" + $FunctionName + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  & $cli cloud functions download -e $EnvId -n $FunctionName -p $tmp --project $ProjectRoot | Out-Null
  $remoteIndex = Get-ChildItem -Path $tmp -Filter "index.js" -Recurse | Select-Object -First 1
  if (-not $remoteIndex) {
    Write-Error "[verify] 校验失败：未能下载云端 index.js，无法确认部署结果"
    exit 1
  }

  $localHash = Get-NormalizedHash $localIndex
  $remoteHash = Get-NormalizedHash $remoteIndex.FullName

  if ($localHash -ne $remoteHash) {
    Write-Host ""
    Write-Host "[verify] 本地代码前 160 字符：" -ForegroundColor Yellow
    Write-Host ((Get-Content -Raw -LiteralPath $localIndex -Encoding UTF8).Substring(0, [Math]::Min(160, (Get-Content -Raw -LiteralPath $localIndex -Encoding UTF8).Length)))
    Write-Host "[verify] 云端代码前 160 字符：" -ForegroundColor Yellow
    $remoteText = Get-Content -Raw -LiteralPath $remoteIndex.FullName -Encoding UTF8
    Write-Host ($remoteText.Substring(0, [Math]::Min(160, $remoteText.Length)))
    Write-Error "[verify] 校验失败：云端 index.js 与本地不一致（本地 $($localHash.Substring(0,12)) / 云端 $($remoteHash.Substring(0,12))）。部署未真正生效，请勿继续发版。"
    exit 1
  }

  Write-Host "[verify] 通过：云端 index.js 与本地一致（$($localHash.Substring(0,12))…）" -ForegroundColor Green
}
finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Write-Host "[deploy] $FunctionName 部署并校验完成"
