param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("protect", "unprotect", "secure-directory", "verify-directory", "verify-new-path", "clipboard")]
  [string]$Operation,

  [Parameter(Mandatory = $true)]
  [string]$Path,

  [ValidateSet("publisher-provenance", "host-evidence", "secret-envelope", "backup-encryption")]
  [string]$Role,

  [ValidateRange(30, 600)]
  [int]$ClipboardSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Assert-AbsolutePath([string]$Value) {
  if (-not [System.IO.Path]::IsPathRooted($Value)) {
    throw "DPAPI path must be absolute."
  }
}

function Assert-NoReparsePath([string]$Value, [bool]$LeafMustExist) {
  $fullPath = [System.IO.Path]::GetFullPath($Value)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw "Signing vault path root is unavailable."
  }
  $relative = $fullPath.Substring($root.Length)
  $current = $root
  $parts = $relative.Split(
    [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
    [System.StringSplitOptions]::RemoveEmptyEntries
  )
  foreach ($part in $parts) {
    $current = [System.IO.Path]::Combine($current, $part)
    if (-not (Test-Path -LiteralPath $current)) {
      if ($LeafMustExist) {
        throw "Signing vault path does not exist."
      }
      break
    }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Signing vault path contains a reparse point."
    }
    $itemFullPath = [System.IO.Path]::GetFullPath($item.FullName)
    if (-not [string]::Equals(
      $itemFullPath.TrimEnd('\'),
      $current.TrimEnd('\'),
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Signing vault path does not match its resolved path."
    }
  }
}

function Get-Entropy([string]$KeyRole) {
  if ([string]::IsNullOrWhiteSpace($KeyRole)) {
    throw "DPAPI key role is required."
  }
  return [System.Text.Encoding]::UTF8.GetBytes(
    "site-logbook:production-signing:v1:$KeyRole"
  )
}

function Set-RestrictedDirectoryAcl([string]$DirectoryPath) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) {
    throw "Current Windows user SID is unavailable."
  }
  $systemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $DirectoryPath -AclObject $security
}

function Assert-RestrictedDirectoryAcl([string]$DirectoryPath) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
  $allowed = @($currentSid.Value, $systemSid.Value)
  $security = Get-Acl -LiteralPath $DirectoryPath
  if ($security.Owner -ne $currentSid.Value) {
    try {
      $ownerSid = (New-Object System.Security.Principal.NTAccount($security.Owner)).Translate(
        [System.Security.Principal.SecurityIdentifier]
      )
    } catch {
      throw "Signing vault owner is unavailable."
    }
    if ($ownerSid.Value -ne $currentSid.Value) {
      throw "Signing vault owner is not the current Windows user."
    }
  }
  if (-not $security.AreAccessRulesProtected) {
    throw "Signing vault ACL inheritance is enabled."
  }
  $rules = $security.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  $currentUserFullControl = $false
  foreach ($rule in $rules) {
    if (
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $allowed -notcontains $rule.IdentityReference.Value
    ) {
      throw "Signing vault grants access to an unapproved principal."
    }
    if (
      $rule.IdentityReference.Value -eq $currentSid.Value -and
      ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
        [System.Security.AccessControl.FileSystemRights]::FullControl
    ) {
      $currentUserFullControl = $true
    }
  }
  if (-not $currentUserFullControl) {
    throw "Signing vault does not grant the current user full control."
  }
}

Assert-AbsolutePath $Path

if ($Operation -eq "verify-new-path") {
  if (Test-Path -LiteralPath $Path) {
    throw "Refusing to use an existing signing vault path."
  }
  Assert-NoReparsePath $Path $false
  [Console]::Out.Write("path=verified")
  exit 0
}

if ($Operation -eq "clipboard") {
  $value = [Console]::In.ReadToEnd().Trim()
  if ($value.Length -lt 64 -or $value.Length -gt 16384) {
    throw "Clipboard payload is outside the reviewed boundary."
  }
  Set-Clipboard -Value $value
  [Console]::Out.WriteLine("clipboard=ready")
  [Console]::Out.WriteLine("clearAfterSeconds=$ClipboardSeconds")
  [Console]::Out.Flush()
  Start-Sleep -Seconds $ClipboardSeconds
  $current = Get-Clipboard -Raw
  if ($current -eq $value) {
    # Windows PowerShell 5.1 treats an empty string as a null clipboard value.
    # Overwrite the secret with a single harmless space instead.
    Set-Clipboard -Value ([char]32)
    [Console]::Out.WriteLine("clipboard=cleared")
  } else {
    [Console]::Out.WriteLine("clipboard=changed-not-cleared")
  }
  $current = $null
  $value = $null
  exit 0
}

if ($Operation -eq "secure-directory") {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Signing vault directory does not exist."
  }
  Assert-NoReparsePath $Path $true
  Set-RestrictedDirectoryAcl $Path
  Assert-NoReparsePath $Path $true
  Assert-RestrictedDirectoryAcl $Path
  [Console]::Out.Write("acl=restricted")
  exit 0
}

if ($Operation -eq "verify-directory") {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Signing vault directory does not exist."
  }
  Assert-NoReparsePath $Path $true
  Assert-RestrictedDirectoryAcl $Path
  [Console]::Out.Write("acl=restricted")
  exit 0
}

$entropy = Get-Entropy $Role
try {
  if ($Operation -eq "protect") {
    Assert-NoReparsePath ([System.IO.Path]::GetDirectoryName($Path)) $true
    if (Test-Path -LiteralPath $Path) {
      throw "Refusing to overwrite an existing protected key."
    }
    $encoded = [Console]::In.ReadToEnd().Trim()
    if ($encoded.Length -lt 16 -or $encoded.Length -gt 16384 -or $encoded -notmatch "^[A-Za-z0-9+/]+={0,2}$") {
      throw "Private-key input is not bounded canonical base64."
    }
    $plain = [Convert]::FromBase64String($encoded)
    try {
      if ($plain.Length -lt 32 -or $plain.Length -gt 8192) {
        throw "Private-key input length is outside the reviewed boundary."
      }
      $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $plain,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      try {
        $stream = [System.IO.File]::Open(
          $Path,
          [System.IO.FileMode]::CreateNew,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
        try {
          $stream.Write($protected, 0, $protected.Length)
          $stream.Flush($true)
        } finally {
          $stream.Dispose()
        }
      } finally {
        [Array]::Clear($protected, 0, $protected.Length)
      }
    } finally {
      [Array]::Clear($plain, 0, $plain.Length)
      $encoded = $null
    }
    exit 0
  }

  if ($Operation -eq "unprotect") {
    Assert-NoReparsePath $Path $true
    $file = Get-Item -LiteralPath $Path
    if ($file.PSIsContainer -or $file.Length -lt 32 -or $file.Length -gt 16384) {
      throw "Protected key file is outside the reviewed boundary."
    }
    $protected = [System.IO.File]::ReadAllBytes($file.FullName)
    try {
      $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      try {
        [Console]::Out.Write([Convert]::ToBase64String($plain))
      } finally {
        [Array]::Clear($plain, 0, $plain.Length)
      }
    } finally {
      [Array]::Clear($protected, 0, $protected.Length)
    }
    exit 0
  }
} finally {
  [Array]::Clear($entropy, 0, $entropy.Length)
}

throw "Unsupported DPAPI operation."
