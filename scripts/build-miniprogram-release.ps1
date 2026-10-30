[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'miniprogram-release'
}
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')

function Test-PathInside {
    param([string]$Parent, [string]$Candidate)
    $prefix = $Parent.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    return $Candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        $Parent.Equals($Candidate, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-ManifestPathInside {
    param(
        [Parameter(Mandatory = $true)][string]$FieldName,
        [Parameter(Mandatory = $true)][string]$ParentRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ([System.IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Replace('\', '/').Split('/') -contains '..') {
        throw "Release manifest path must be relative and stay inside its parent directory: $FieldName"
    }

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $ParentRoot $RelativePath))
    $parentPrefix = $ParentRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($candidate.Equals($ParentRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $candidate.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release manifest path must be relative and stay inside its parent directory: $FieldName"
    }
}

function Get-Sha256 {
    param([string]$Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Remove-FileIfPresent {
    param([string]$Path)
    if (-not [string]::IsNullOrWhiteSpace($Path) -and
        (Test-Path -LiteralPath $Path -PathType Leaf)) {
        [System.IO.File]::Delete($Path)
    }
}

function Test-ExcludedPath {
    param(
        [string]$RelativePath,
        [object[]]$Patterns
    )

    $normalizedPath = $RelativePath.Replace('\', '/').TrimStart('/')
    foreach ($entry in $Patterns) {
        $pattern = ([string]$entry).Replace('\', '/').TrimStart('/')
        if ([string]::IsNullOrWhiteSpace($pattern)) {
            continue
        }

        if ($pattern.EndsWith('/')) {
            $directoryPattern = $pattern.TrimEnd('/')
            if ($normalizedPath -like $directoryPattern -or
                $normalizedPath -like "$directoryPattern/*" -or
                $normalizedPath -like "*/$directoryPattern" -or
                $normalizedPath -like "*/$directoryPattern/*") {
                return $true
            }
        } elseif (
            $normalizedPath -like $pattern -or
            ($pattern.IndexOf('/') -lt 0 -and
                ([System.IO.Path]::GetFileName($normalizedPath) -like $pattern))
        ) {
            return $true
        }
    }

    return $false
}

if (Test-PathInside -Parent $ProjectRoot -Candidate $OutputRoot) {
    throw 'OutputRoot must be outside the project directory.'
}
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "Project directory not found: $ProjectRoot"
}

$manifestPath = Join-Path $ProjectRoot 'scripts/release-manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$requiredManifestStringFields = @(
    'version',
    'appid',
    'envId',
    'miniprogramRoot',
    'cloudfunctionRoot'
)
foreach ($fieldName in $requiredManifestStringFields) {
    $field = $manifest.PSObject.Properties[$fieldName]
    if ($null -eq $field -or
        $field.Value -isnot [string] -or
        [string]::IsNullOrWhiteSpace([string]$field.Value)) {
        throw "Release manifest field must be a non-empty string: $fieldName"
    }
}
Assert-ManifestPathInside -FieldName 'miniprogramRoot' -ParentRoot $ProjectRoot -RelativePath ([string]$manifest.miniprogramRoot)
Assert-ManifestPathInside -FieldName 'cloudfunctionRoot' -ParentRoot $ProjectRoot -RelativePath ([string]$manifest.cloudfunctionRoot)
$cloudfunctionRootPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $manifest.cloudfunctionRoot))

$cloudFunctions = @()
$cloudFunctionsField = $manifest.PSObject.Properties['cloudFunctions']
if ($null -eq $cloudFunctionsField -or $cloudFunctionsField.Value -isnot [System.Array]) {
    throw 'Release manifest cloudFunctions must be an array.'
}
$cloudFunctions = @($cloudFunctionsField.Value)
if ($cloudFunctions.Count -eq 0) {
    throw 'Release manifest cloudFunctions must contain at least one function.'
}
foreach ($functionName in $cloudFunctions) {
    if ($functionName -isnot [string] -or [string]::IsNullOrWhiteSpace($functionName)) {
        throw 'Release manifest cloudFunctions must contain only non-empty strings.'
    }
}
$cloudFunctions = @($cloudFunctions | ForEach-Object { $_.Trim() })
if (@($cloudFunctions | Select-Object -Unique).Count -ne $cloudFunctions.Count) {
    throw 'Release manifest cloudFunctions must contain unique function names.'
}
foreach ($functionName in $cloudFunctions) {
    Assert-ManifestPathInside -FieldName "cloudFunctions[$functionName]" -ParentRoot $cloudfunctionRootPath -RelativePath $functionName
}

$excludedFromRelease = @()
if ($null -ne $manifest.PSObject.Properties['excludedFromRelease']) {
    $excludedFromRelease = @($manifest.excludedFromRelease)
}
$package = [System.IO.File]::ReadAllText((Join-Path $ProjectRoot 'package.json')) | ConvertFrom-Json
if ($package.version -ne $manifest.version) {
    throw "Version mismatch: package.json=$($package.version), release manifest=$($manifest.version)"
}
$projectConfigPath = Join-Path $ProjectRoot 'project.config.json'
if (-not (Test-Path -LiteralPath $projectConfigPath -PathType Leaf)) {
    throw 'Required release input is missing: project.config.json'
}
$projectConfig = [System.IO.File]::ReadAllText($projectConfigPath) | ConvertFrom-Json
if ([string]$projectConfig.appid -ne [string]$manifest.appid) {
    throw "AppID mismatch: project.config.json=$($projectConfig.appid), release manifest=$($manifest.appid)"
}

foreach ($functionName in $cloudFunctions) {
    $functionRoot = Join-Path $cloudfunctionRootPath $functionName
    $functionPackagePath = Join-Path $functionRoot 'package.json'
    if (-not (Test-Path -LiteralPath $functionPackagePath -PathType Leaf)) {
        throw "Required cloud function package metadata is missing: $functionName/package.json"
    }
    $functionPackage = [System.IO.File]::ReadAllText($functionPackagePath) | ConvertFrom-Json
    if ([string]$functionPackage.version -ne [string]$manifest.version) {
        throw "Version mismatch: cloudfunctions/$functionName/package.json=$($functionPackage.version), release manifest=$($manifest.version)"
    }

    $functionConfigPath = Join-Path $functionRoot 'config.json'
    if (Test-Path -LiteralPath $functionConfigPath -PathType Leaf) {
        $functionConfig = [System.IO.File]::ReadAllText($functionConfigPath) | ConvertFrom-Json
        if ($null -ne $functionConfig.PSObject.Properties['version'] -and
            [string]$functionConfig.version -ne [string]$manifest.version) {
            throw "Version mismatch: cloudfunctions/$functionName/config.json=$($functionConfig.version), release manifest=$($manifest.version)"
        }
    }
}

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("miniprogram-release-" + [Guid]::NewGuid().ToString('N'))
$staging = Join-Path $stageRoot 'payload'
[void][System.IO.Directory]::CreateDirectory($staging)
$archivePath = Join-Path $stageRoot "miniprogram-$($manifest.version).zip"
$finalPath = $null
$finalManifestPath = $null
$publishRoot = $null
$tempArchivePath = $null
$tempManifestPath = $null
$createdFinalArchive = $false
$createdFinalManifest = $false
$entryCount = 0

try {
    $requiredTopLevel = @('project.config.json', $manifest.miniprogramRoot)
    foreach ($functionName in $cloudFunctions) {
        $requiredTopLevel += "$($manifest.cloudfunctionRoot)/$functionName"
    }

    foreach ($relativePath in $requiredTopLevel) {
        $sourcePath = Join-Path $ProjectRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            throw "Required release input is missing: $relativePath"
        }
        $destinationPath = Join-Path $staging $relativePath
        $destinationParent = Split-Path -Parent $destinationPath
        [void][System.IO.Directory]::CreateDirectory($destinationParent)
        if ((Get-Item -LiteralPath $sourcePath).PSIsContainer) {
            [System.IO.Directory]::CreateDirectory($destinationPath) | Out-Null
            Get-ChildItem -LiteralPath $sourcePath -Force -Recurse |
                Where-Object { -not $_.PSIsContainer } |
                ForEach-Object {
                    $relative = $_.FullName.Substring($ProjectRoot.Length).TrimStart('\', '/')
                    if (-not (Test-ExcludedPath -RelativePath $relative -Patterns $excludedFromRelease) -and
                        $relative -notmatch '(^|[\\/])(node_modules|\.git)([\\/]|$)') {
                        $target = Join-Path $staging $relative
                        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $target))
                        [System.IO.File]::Copy($_.FullName, $target, $true)
                    }
                }
        } else {
            $relative = $relativePath.Replace('\', '/')
            if (-not (Test-ExcludedPath -RelativePath $relative -Patterns $excludedFromRelease)) {
                [System.IO.File]::Copy($sourcePath, $destinationPath, $true)
            }
        }
    }

    $configPath = Join-Path $staging 'project.config.json'
    $config = [System.IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $config.cloudfunctionRoot = "$($manifest.cloudfunctionRoot)/"
    $config.miniprogramRoot = "$($manifest.miniprogramRoot)/"
    [System.IO.File]::WriteAllText(
        $configPath,
        (ConvertTo-Json -InputObject $config -Depth 20),
        (New-Object System.Text.UTF8Encoding($false))
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $staging,
        $archivePath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $names = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $entryCount = [int]$zip.Entries.Count
        $uniqueNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($name in $names) {
            if (-not $uniqueNames.Add($name)) {
                throw "Generated ZIP contains a duplicate path: $name"
            }
        }
        if (-not ($names -contains 'project.config.json') -or
            -not ($names -contains "$($manifest.miniprogramRoot)/app.json")) {
            throw 'Generated ZIP is missing required mini-program files.'
        }
        if (@($names | Where-Object { $_ -match '(^|/)(node_modules|\.git|logs|shots|AI_SYNC|AI协作模块)(/|$)' }).Count -gt 0) {
            throw 'Generated ZIP contains a forbidden local-only path.'
        }
        $excludedNames = @($names | Where-Object {
            Test-ExcludedPath -RelativePath $_ -Patterns $excludedFromRelease
        })
        if ($excludedNames.Count -gt 0) {
            throw "Generated ZIP contains an excluded path: $($excludedNames[0])"
        }
        foreach ($functionName in $cloudFunctions) {
            if (-not ($names -contains "$($manifest.cloudfunctionRoot)/$functionName/index.js")) {
                throw "Generated ZIP is missing cloud function: $functionName"
            }
        }
    } finally {
        $zip.Dispose()
    }

    [void][System.IO.Directory]::CreateDirectory($OutputRoot)
    $finalPath = Join-Path $OutputRoot ([System.IO.Path]::GetFileName($archivePath))
    $finalManifestPath = "$finalPath.manifest.json"
    if (Test-Path -LiteralPath $finalPath) {
        throw "Refusing to overwrite existing release archive: $finalPath"
    }
    if (Test-Path -LiteralPath $finalManifestPath) {
        throw "Refusing to overwrite existing release manifest: $finalManifestPath"
    }

    $archiveManifest = [ordered]@{
        version = $manifest.version
        appid = $manifest.appid
        env_id = $manifest.envId
        archive_name = [System.IO.Path]::GetFileName($finalPath)
        sha256 = $null
        entry_count = $entryCount
        cloud_functions = @($cloudFunctions)
    }

    $buildToken = [Guid]::NewGuid().ToString('N')
    $publishRoot = Join-Path $OutputRoot ".miniprogram-release-$buildToken"
    if (Test-Path -LiteralPath $publishRoot) {
        throw "Release staging path already exists: $publishRoot"
    }
    [void][System.IO.Directory]::CreateDirectory($publishRoot)
    $tempArchivePath = Join-Path $publishRoot ([System.IO.Path]::GetFileName($finalPath))
    $tempManifestPath = Join-Path $publishRoot ([System.IO.Path]::GetFileName($finalManifestPath))
    [System.IO.File]::Copy($archivePath, $tempArchivePath, $false)
    $hash = Get-Sha256 -Path $tempArchivePath
    $archiveManifest.sha256 = $hash
    [System.IO.File]::WriteAllText(
        $tempManifestPath,
        (ConvertTo-Json -InputObject $archiveManifest -Depth 10),
        (New-Object System.Text.UTF8Encoding($false))
    )

    if (-not (Test-Path -LiteralPath $tempArchivePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $tempManifestPath -PathType Leaf)) {
        throw 'Release staging did not produce both archive and manifest.'
    }

    [System.IO.File]::Move($tempArchivePath, $finalPath)
    $createdFinalArchive = $true
    [System.IO.File]::Move($tempManifestPath, $finalManifestPath)
    $createdFinalManifest = $true
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{
        success = $true
        version = $manifest.version
        appid = $manifest.appid
        env_id = $manifest.envId
        archive = $finalPath
        manifest = $finalManifestPath
        sha256 = $hash
        entry_count = $entryCount
        cloud_functions = @($cloudFunctions)
    } -Compress))
} catch {
    Remove-FileIfPresent -Path $tempManifestPath
    Remove-FileIfPresent -Path $tempArchivePath
    if ($createdFinalManifest) {
        Remove-FileIfPresent -Path $finalManifestPath
    }
    if ($createdFinalArchive) {
        Remove-FileIfPresent -Path $finalPath
    }
    throw
} finally {
    if ($publishRoot -and (Test-Path -LiteralPath $publishRoot -PathType Container)) {
        [System.IO.Directory]::Delete($publishRoot, $true)
    }
    if (Test-Path -LiteralPath $stageRoot -PathType Container) {
        [System.IO.Directory]::Delete($stageRoot, $true)
    }
}
