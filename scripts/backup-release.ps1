[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$BackupRoot,
    [ValidateSet('WorkingTree', 'GitCommit')]
    [string]$SourceKind = 'WorkingTree',
    [string]$Commitish = 'HEAD',
    [string]$Label,
    [ValidateRange(2, 20)]
    [int]$Keep = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $volumeRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $volumeRoot.Length) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
}

function Test-PathsOverlap {
    param(
        [Parameter(Mandatory = $true)][string]$First,
        [Parameter(Mandatory = $true)][string]$Second
    )

    $firstPath = Get-NormalizedPath -Path $First
    $secondPath = Get-NormalizedPath -Path $Second
    if ($firstPath.Equals($secondPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $separator = [System.IO.Path]::DirectorySeparatorChar
    $firstPrefix = $firstPath + $separator
    $secondPrefix = $secondPath + $separator
    return $firstPath.StartsWith($secondPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        $secondPath.StartsWith($firstPrefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-SafeToken {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return 'unnamed'
    }

    $safe = [regex]::Replace($Value.Trim(), '[^A-Za-z0-9._-]+', '-').Trim('-', '.', '_')
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return 'unnamed'
    }
    if ($safe.Length -gt 48) {
        return $safe.Substring(0, 48)
    }
    return $safe
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hashBytes = $algorithm.ComputeHash($stream)
        return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Invoke-GitCapture {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & git -C $script:ProjectRootFull @Arguments 2>&1
    $gitExitCode = $LASTEXITCODE
    if ($gitExitCode -ne 0) {
        throw "Git command failed ($($Arguments -join ' ')): $($output -join ' ')"
    }
    return ($output -join "`n").Trim()
}

function Test-ExcludedFile {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($Name -ieq 'project.private.config.json') {
        return $true
    }
    if ($Name -match '^\.(env)(\.|$)') {
        return $true
    }

    $extension = [System.IO.Path]::GetExtension($Name)
    return $extension -in @('.log', '.pem', '.key', '.p12', '.pfx')
}

function Get-ReleaseExclusions {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)

    $manifestPath = Join-Path $SourceRoot 'scripts/release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return @()
    }

    try {
        $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
        return @($manifest.excludedFromRelease | ForEach-Object { [string]$_ })
    } catch {
        throw "Could not read scripts/release-manifest.json: $($_.Exception.Message)"
    }
}

function Test-ReleaseManifestExcluded {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $false)][AllowEmptyCollection()][AllowNull()][string[]]$Patterns = @()
    )

    if ($null -eq $Patterns) {
        return $false
    }

    $normalizedPath = $RelativePath.Replace('\', '/')
    foreach ($pattern in $Patterns) {
        $normalizedPattern = ([string]$pattern).Replace('\', '/')
        if ($normalizedPattern.EndsWith('/')) {
            $directoryPrefix = $normalizedPattern.TrimEnd('/')
            if ($normalizedPath.StartsWith("$directoryPrefix/", [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
            continue
        }

        $regex = '^' + [regex]::Escape($normalizedPattern).Replace('\*', '.*') + '$'
        if ($normalizedPath -match $regex) {
            return $true
        }
    }
    return $false
}

function Get-SnapshotFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $false)][string[]]$ReleaseExclusions = @()
    )

    $files = New-Object 'System.Collections.Generic.List[object]'
    $pendingDirectories = New-Object 'System.Collections.Generic.Stack[string]'
    $pendingDirectories.Push($SourceRoot)

    while ($pendingDirectories.Count -gt 0) {
        $currentDirectory = $pendingDirectories.Pop()
        foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($currentDirectory)) {
            $entryName = [System.IO.Path]::GetFileName($entryPath)
            $attributes = [System.IO.File]::GetAttributes($entryPath)
            $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
            $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

            if ($isDirectory) {
                if ($entryName -in @('.git', 'node_modules') -or $isReparsePoint) {
                    continue
                }
                $pendingDirectories.Push($entryPath)
                continue
            }

            if ($isReparsePoint -or (Test-ExcludedFile -Name $entryName)) {
                continue
            }

            $relativePath = $entryPath.Substring($SourceRoot.Length).TrimStart([char[]]@('\', '/'))
            $relativeZipPath = $relativePath.Replace('\', '/')
            if (Test-ReleaseManifestExcluded -RelativePath $relativeZipPath -Patterns $ReleaseExclusions) {
                continue
            }
            if ($relativeZipPath.Equals('release-manifest.json', [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'The project already contains reserved file release-manifest.json.'
            }

            $destinationPath = Join-Path $DestinationRoot $relativePath
            $destinationDirectory = [System.IO.Path]::GetDirectoryName($destinationPath)
            [void][System.IO.Directory]::CreateDirectory($destinationDirectory)
            [System.IO.File]::Copy($entryPath, $destinationPath, $false)
            # 复制会保留源文件的只读属性；若不清除，后续保留策略删除工作目录会抛 Access denied
            # （2026-10-25 实测：审核文件/*.mp4 为只读，导致归档成功却返回失败）
            [System.IO.File]::SetAttributes($destinationPath, [System.IO.FileAttributes]::Normal)

            $destinationInfo = New-Object System.IO.FileInfo($destinationPath)
            $files.Add([pscustomobject]@{
                path = $relativeZipPath
                bytes = $destinationInfo.Length
                sha256 = Get-FileSha256 -Path $destinationPath
            })
        }
    }

    return @($files | Sort-Object -Property path)
}

function Get-PackageMetadata {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)

    $packagePath = Join-Path $SourceRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        return [pscustomobject]@{ name = 'project'; version = 'unknown' }
    }

    try {
        $package = [System.IO.File]::ReadAllText($packagePath) | ConvertFrom-Json
        $name = if ([string]::IsNullOrWhiteSpace([string]$package.name)) { 'project' } else { [string]$package.name }
        $version = if ([string]::IsNullOrWhiteSpace([string]$package.version)) { 'unknown' } else { [string]$package.version }
        return [pscustomobject]@{ name = $name; version = $version }
    } catch {
        throw "Could not read package.json: $($_.Exception.Message)"
    }
}

function Get-ManagedBackups {
    param([Parameter(Mandatory = $true)][string]$NamePrefix)

    $managed = New-Object 'System.Collections.Generic.List[object]'
    foreach ($archiveFile in Get-ChildItem -LiteralPath $script:BackupRootFull -File -Filter "$NamePrefix-*.zip") {
        $metadataPath = "$($archiveFile.FullName).manifest.json"
        if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
            continue
        }

        try {
            $metadata = [System.IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
            if ($metadata.schema -ne 'codex-project-release-backup/v1' -or
                $metadata.archive_file -ne $archiveFile.Name -or
                $metadata.archive_sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
                continue
            }
            if ((Get-FileSha256 -Path $archiveFile.FullName) -ne $metadata.archive_sha256.ToLowerInvariant()) {
                continue
            }
            $createdAt = [DateTimeOffset]::Parse([string]$metadata.created_at_utc)
            $managed.Add([pscustomobject]@{
                archive = $archiveFile.FullName
                metadata = $metadataPath
                created_at_utc = $createdAt
            })
        } catch {
            continue
        }
    }
    return $managed.ToArray()
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 12
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-Archive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$VerificationRoot,
        [Parameter(Mandatory = $true)][object[]]$ExpectedFiles
    )

    $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entryNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            $normalizedName = $entry.FullName.Replace('\', '/')
            if ($normalizedName.StartsWith('/') -or $normalizedName -match '(^|/)\.\.(/|$)') {
                throw "Unsafe path in generated archive: $normalizedName"
            }
            if (-not $entryNames.Add($normalizedName)) {
                throw "Duplicate path in generated archive: $normalizedName"
            }
        }
        if (-not $entryNames.Contains('release-manifest.json')) {
            throw 'Generated archive is missing release-manifest.json.'
        }
        if ($entryNames.Count -ne ($ExpectedFiles.Count + 1)) {
            throw 'Generated archive file count does not match its manifest.'
        }
    } finally {
        $zip.Dispose()
    }

    [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $VerificationRoot)
    $manifestPath = Join-Path $VerificationRoot 'release-manifest.json'
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schema -ne 'codex-project-release-backup/v1' -or
        @($manifest.files).Count -ne $ExpectedFiles.Count) {
        throw 'Generated archive manifest is invalid.'
    }

    foreach ($file in $ExpectedFiles) {
        $relativePath = ([string]$file.path).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $filePath = Get-NormalizedPath -Path (Join-Path $VerificationRoot $relativePath)
        if (-not $filePath.StartsWith(
                (Get-NormalizedPath -Path $VerificationRoot) + [System.IO.Path]::DirectorySeparatorChar,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw "Manifest path escapes the archive: $($file.path)"
        }
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw "Generated archive is missing file: $($file.path)"
        }
        if ((Get-FileSha256 -Path $filePath) -ne [string]$file.sha256) {
            throw "Generated archive hash check failed: $($file.path)"
        }
    }
}

$script:ProjectRootFull = Get-NormalizedPath -Path $ProjectRoot
if (-not (Test-Path -LiteralPath $script:ProjectRootFull -PathType Container)) {
    [Console]::Error.WriteLine("Project directory not found: $script:ProjectRootFull")
    exit 1
}

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $projectParent = Split-Path -Parent $script:ProjectRootFull
    $projectFolderName = Split-Path -Leaf $script:ProjectRootFull
    $BackupRoot = Join-Path $projectParent "$projectFolderName-release-backups"
}
$script:BackupRootFull = Get-NormalizedPath -Path $BackupRoot

if (Test-PathsOverlap -First $script:ProjectRootFull -Second $script:BackupRootFull) {
    [Console]::Error.WriteLine('BackupRoot must be separate from, and must not contain, the project directory.')
    exit 1
}

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
} catch {
    [Console]::Error.WriteLine("Could not load ZIP support: $($_.Exception.Message)")
    exit 1
}

$workRoot = $null
$lockStream = $null
$newArchivePath = $null
$newMetadataPath = $null
$published = $false
$exitCode = 0

try {
    [void][System.IO.Directory]::CreateDirectory($script:BackupRootFull)
    $lockPath = Join-Path $script:BackupRootFull '.backup-release.lock'
    $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("pid=$PID`n")
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    $lockStream.Flush()

    $workRoot = Join-Path $script:BackupRootFull ('.tmp-' + [Guid]::NewGuid().ToString('N'))
    $sourceRoot = Join-Path $workRoot 'source'
    $payloadRoot = Join-Path $workRoot 'payload'
    $verificationRoot = Join-Path $workRoot 'verification'
    [void][System.IO.Directory]::CreateDirectory($sourceRoot)
    [void][System.IO.Directory]::CreateDirectory($payloadRoot)

    $gitCommit = $null
    $gitDirty = $null
    $sourceRef = $null
    if ($SourceKind -eq 'GitCommit') {
        $sourceRef = Invoke-GitCapture -Arguments @('rev-parse', '--verify', "$Commitish^{commit}")
        if ($sourceRef -notmatch '^[A-Fa-f0-9]{40,64}$') {
            throw 'Git returned an invalid commit identifier.'
        }
        $gitCommit = $sourceRef
        $gitArchivePath = Join-Path $workRoot 'git-source.zip'
        $gitOutput = & git -C $script:ProjectRootFull archive --format=zip "--output=$gitArchivePath" $sourceRef 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Could not archive Git commit: $($gitOutput -join ' ')"
        }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($gitArchivePath, $sourceRoot)
    } else {
        try {
            $gitCommit = Invoke-GitCapture -Arguments @('rev-parse', 'HEAD')
            $gitStatus = Invoke-GitCapture -Arguments @('status', '--porcelain', '--untracked-files=all')
            $gitDirty = -not [string]::IsNullOrWhiteSpace($gitStatus)
        } catch {
            $gitCommit = $null
            $gitDirty = $null
        }
        $sourceRoot = $script:ProjectRootFull
    }

    $releaseExclusions = Get-ReleaseExclusions -SourceRoot $sourceRoot
    $package = Get-PackageMetadata -SourceRoot $sourceRoot
    $labelValue = if ([string]::IsNullOrWhiteSpace($Label)) {
        if ($SourceKind -eq 'GitCommit') { 'git-' + $gitCommit.Substring(0, 8) } else { 'working-tree' }
    } else {
        $Label.Trim()
    }
    $files = @(Get-SnapshotFiles -SourceRoot $sourceRoot -DestinationRoot $payloadRoot -ReleaseExclusions $releaseExclusions)
    if ($files.Count -eq 0) {
        throw 'Refusing to create an empty project snapshot.'
    }

    $metadataExclusions = @(
        '.git/**'
        'node_modules/**'
        'project.private.config.json'
        '.env*'
        '*.log'
        '*.pem'
        '*.key'
        '*.p12'
        '*.pfx'
        'reparse points / symbolic links'
        $releaseExclusions
    ) | Select-Object -Unique

    $createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    $namePrefix = ConvertTo-SafeToken -Value $package.name
    $versionToken = ConvertTo-SafeToken -Value $package.version
    $kindToken = if ($SourceKind -eq 'GitCommit') { 'git' } else { 'worktree' }
    $labelToken = ConvertTo-SafeToken -Value $labelValue
    $uniqueToken = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $archiveName = "$namePrefix-$versionToken-$kindToken-$labelToken-$timestamp-$uniqueToken.zip"
    $temporaryArchivePath = Join-Path $workRoot $archiveName
    $newArchivePath = Join-Path $script:BackupRootFull $archiveName
    $newMetadataPath = "$newArchivePath.manifest.json"

    $releaseManifest = [ordered]@{
        schema = 'codex-project-release-backup/v1'
        source_kind = $SourceKind
        source_ref = $sourceRef
        label = $labelValue
        created_at_utc = $createdAtUtc
        package_name = $package.name
        package_version = $package.version
        git_commit = $gitCommit
        git_dirty = $gitDirty
        exclusions = @($metadataExclusions)
        files = @($files)
    }
    $releaseManifestPath = Join-Path $payloadRoot 'release-manifest.json'
    Write-Utf8Json -Path $releaseManifestPath -Value $releaseManifest

    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $payloadRoot,
        $temporaryArchivePath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    [void][System.IO.Directory]::CreateDirectory($verificationRoot)
    Test-Archive -ArchivePath $temporaryArchivePath -VerificationRoot $verificationRoot -ExpectedFiles $files

    $archiveSha256 = Get-FileSha256 -Path $temporaryArchivePath
    $metadata = [ordered]@{
        schema = 'codex-project-release-backup/v1'
        archive_file = $archiveName
        archive_sha256 = $archiveSha256
        archive_size_bytes = (New-Object System.IO.FileInfo($temporaryArchivePath)).Length
        manifest_sha256 = Get-FileSha256 -Path $releaseManifestPath
        created_at_utc = $createdAtUtc
        source_kind = $SourceKind
        source_ref = $sourceRef
        label = $labelValue
        package_name = $package.name
        package_version = $package.version
        git_commit = $gitCommit
        git_dirty = $gitDirty
        file_count = $files.Count
    }

    $temporaryMetadataPath = Join-Path $workRoot ($archiveName + '.manifest.json')
    Write-Utf8Json -Path $temporaryMetadataPath -Value $metadata
    [System.IO.File]::Move($temporaryArchivePath, $newArchivePath)
    try {
        [System.IO.File]::Move($temporaryMetadataPath, $newMetadataPath)
    } catch {
        [System.IO.File]::Delete($newArchivePath)
        throw
    }
    $published = $true

    $managedBackups = @(Get-ManagedBackups -NamePrefix $namePrefix | Sort-Object -Property created_at_utc -Descending)
    $removed = New-Object 'System.Collections.Generic.List[string]'
    if ($managedBackups.Count -gt $Keep) {
        foreach ($oldBackup in @($managedBackups | Select-Object -Skip $Keep)) {
            [System.IO.File]::Delete($oldBackup.archive)
            [System.IO.File]::Delete($oldBackup.metadata)
            $removed.Add([System.IO.Path]::GetFileName($oldBackup.archive))
        }
    }

    $result = [ordered]@{
        success = $true
        archive = $newArchivePath
        archive_sha256 = $archiveSha256
        source_kind = $SourceKind
        label = $labelValue
        git_commit = $gitCommit
        git_dirty = $gitDirty
        file_count = $files.Count
        retained_valid_versions = [Math]::Min($managedBackups.Count, $Keep)
        removed_archives = @($removed)
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
} catch {
    $exitCode = 1
    [Console]::Error.WriteLine("Release backup failed: $($_.Exception.Message)")
    if ($_.ScriptStackTrace) {
        [Console]::Error.WriteLine($_.ScriptStackTrace)
    }
    if (-not $published) {
        if ($newMetadataPath -and (Test-Path -LiteralPath $newMetadataPath -PathType Leaf)) {
            [System.IO.File]::Delete($newMetadataPath)
        }
        if ($newArchivePath -and (Test-Path -LiteralPath $newArchivePath -PathType Leaf)) {
            [System.IO.File]::Delete($newArchivePath)
        }
    }
} finally {
    if ($lockStream) {
        $lockStream.Dispose()
        $lockPath = Join-Path $script:BackupRootFull '.backup-release.lock'
        if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
            [System.IO.File]::Delete($lockPath)
        }
    }
    if ($workRoot -and (Test-Path -LiteralPath $workRoot -PathType Container)) {
        # 兜底：工作目录里可能残留只读文件，先清属性再删，避免"归档成功却抛异常"
        try {
            Get-ChildItem -LiteralPath $workRoot -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
                try { $_.IsReadOnly = $false } catch { }
            }
        } catch { }
        try {
            [System.IO.Directory]::Delete($workRoot, $true)
        } catch {
            Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($exitCode -ne 0) {
    exit $exitCode
}
