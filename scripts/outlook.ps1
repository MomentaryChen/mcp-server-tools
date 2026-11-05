# Read-only Outlook (classic) access via COM, used by modules/outlook.js.
#
# Usage:
#   outlook.ps1 serve                          long-running worker (used by modules/outlook.js):
#                                              reads one JSON request per stdin line   {"id":1,"action":"...","params":{...}}
#                                              writes one JSON response per stdout line {"id":1,"ok":true,"data":...}
#   outlook.ps1 <action> <base64-utf8-json>    one-shot (manual testing): prints { ok, data } or { ok, error }
#
# Env: OUTLOOK_SEARCH_MODE          auto (default: indexed search for plain ASCII queries) | like (always LIKE)
#      OUTLOOK_FOLDER_CACHE_SECONDS how long the mailbox folder list is cached in serve mode (default 300)
param(
  [string]$Action = 'serve',
  [string]$ParamsB64 = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$SearchMode = if ($env:OUTLOOK_SEARCH_MODE) { $env:OUTLOOK_SEARCH_MODE.ToLower() } else { 'auto' }
$FolderCacheSeconds = if ($env:OUTLOOK_FOLDER_CACHE_SECONDS) { [int]$env:OUTLOOK_FOLDER_CACHE_SECONDS } else { 300 }

$defaultFolders = @{ 'inbox' = 6; 'sent' = 5; 'sent items' = 5; 'drafts' = 16; 'deleted' = 3; 'deleted items' = 3; 'junk' = 23; 'junk email' = 23; 'outbox' = 4 }

$script:p = @{}
$script:ol = $null
$script:ns = $null
$script:root = $null
$script:folderCache = $null

function Connect-Outlook {
  $script:ol = New-Object -ComObject Outlook.Application
  $script:ns = $script:ol.GetNamespace('MAPI')
  $script:root = $script:ns.GetDefaultFolder(6).Parent
  $script:folderCache = $null
}

function ConvertTo-ParamTable($obj) {
  $table = @{}
  if ($obj) { foreach ($prop in $obj.PSObject.Properties) { $table[$prop.Name] = $prop.Value } }
  return $table
}

function Get-Param($name, $default) { if ($script:p.ContainsKey($name) -and $null -ne $script:p[$name] -and "$($script:p[$name])" -ne '') { $script:p[$name] } else { $default } }

function New-List { , ([System.Collections.Generic.List[object]]::new()) }

function Get-RelativePath($folder) { "$($folder.FolderPath)" -replace '^\\\\[^\\]+\\', '' -replace '\\', '/' }

function Resolve-Folder([string]$path) {
  if (-not $path) { return $script:ns.GetDefaultFolder(6) }
  $parts = $path.Trim('/', '\') -split '[/\\]'
  $first = $parts[0].ToLower()
  if ($defaultFolders.ContainsKey($first)) { $f = $script:ns.GetDefaultFolder($defaultFolders[$first]); $rest = $parts | Select-Object -Skip 1 }
  else { $f = $script:root; $rest = $parts }
  foreach ($name in $rest) {
    $next = $null
    # Folder names containing '/' are reported as '%2F' (see Get-RelativePath)
    $decoded = $name -replace '%2F', '/'
    foreach ($sub in $f.Folders) { if ($sub.Name -ieq $decoded) { $next = $sub; break } }
    if (-not $next) { throw "Folder not found: $path (missing '$name')" }
    $f = $next
  }
  return $f
}

# Cached SMTP properties are read first: GetExchangeUser() is a GAL lookup per call and gets slow on long recipient lists.
$PR_SENDER_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'
$PR_SMTP_ADDRESS = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001F'

function Get-SenderAddress($m) {
  if ($m.SenderEmailType -ne 'EX') { return $m.SenderEmailAddress }
  try { $a = $m.PropertyAccessor.GetProperty($PR_SENDER_SMTP); if ($a) { return $a } } catch {}
  try { $u = $m.Sender.GetExchangeUser(); if ($u) { return $u.PrimarySmtpAddress } } catch {}
  return $m.SenderEmailAddress
}

function Get-RecipientAddress($r) {
  try { $a = $r.PropertyAccessor.GetProperty($PR_SMTP_ADDRESS); if ($a) { return $a } } catch {}
  try { $u = $r.AddressEntry.GetExchangeUser(); if ($u) { return $u.PrimarySmtpAddress } } catch {}
  return $r.Address
}

function Format-Date($d) { if ($d) { ([datetime]$d).ToString('yyyy-MM-ddTHH:mm:ss') } else { $null } }

function Convert-Summary($m, $folder) {
  [ordered]@{
    id             = $m.EntryID
    folder         = Get-RelativePath $folder
    receivedTime   = Format-Date $m.ReceivedTime
    from           = $m.SenderName
    fromAddress    = Get-SenderAddress $m
    subject        = $m.Subject
    unread         = [bool]$m.UnRead
    hasAttachments = ($m.Attachments.Count -gt 0)
    categories     = $m.Categories
    messageClass   = $m.MessageClass
  }
}

function Escape-Dasl([string]$s) { $s.Replace("'", "''") }

# Adds the newest $limit matching items of $folder to $list as cheap { time; item; folder } refs.
# $filters are tried in order: if the Windows index can't serve a ci_* filter for this
# folder's store, fall back to the LIKE one.
function Add-TopItems($folder, [string[]]$filters, [int]$limit, $list) {
  $items = $folder.Items
  if ($filters -and $filters[0]) {
    $restricted = $null
    foreach ($filter in $filters) {
      try { $restricted = $items.Restrict($filter); break } catch { if ($filter -eq $filters[-1]) { throw } }
    }
    $items = $restricted
  }
  if ($items.Count -eq 0) { return }
  $items.Sort('[ReceivedTime]', $true)
  $n = 0
  foreach ($m in $items) {
    if ($n -ge $limit) { break }
    try { $list.Add([pscustomobject]@{ time = $m.ReceivedTime; item = $m; folder = $folder }); $n++ } catch {}  # skip items that fail to load
  }
}

# Full summaries only for the refs that are returned: Convert-Summary costs several COM
# property reads per item, so a whole-mailbox search must not run it on every folder's top N.
function Convert-Refs($refs) {
  $out = New-List
  foreach ($r in $refs) {
    try { $out.Add((Convert-Summary $r.item $r.folder)) } catch {}  # skip corrupted / protected items
  }
  return , $out
}

function Get-Messages($folder, [string[]]$filters, [int]$limit) {
  $refs = New-List
  Add-TopItems $folder $filters $limit $refs
  return , (Convert-Refs $refs)
}

# Indexed (ci_startswith) search is ~15x faster than LIKE but word-based: it misses most CJK
# text and mis-tokenizes punctuation, so it is only used for plain ASCII word queries.
function Use-IndexedSearch([string]$query) {
  $SearchMode -ne 'like' -and $query -match '^[A-Za-z0-9_ ]+$' -and $script:ns.DefaultStore.IsInstantSearchEnabled
}

function Join-Filter($clauses) { if ($clauses.Count -eq 0) { '' } else { '@SQL=' + ($clauses -join ' AND ') } }

# Returns the DASL filters to try, preferred first ('' = no filter).
function Build-Filters([string]$query, [string]$field, [string]$since, [string]$until, [bool]$unreadOnly) {
  $common = @()
  if ($since) { $common += "`"urn:schemas:httpmail:datereceived`" >= '$(([datetime]$since).ToUniversalTime().ToString('yyyy-MM-dd HH:mm'))'" }
  if ($until) { $common += "`"urn:schemas:httpmail:datereceived`" < '$(([datetime]$until).ToUniversalTime().ToString('yyyy-MM-dd HH:mm'))'" }
  if ($unreadOnly) { $common += '"urn:schemas:httpmail:read" = 0' }
  if (-not $query) { return , @(Join-Filter $common) }

  $q = Escape-Dasl $query.Trim()
  $cols = switch ($field) {
    'subject' { @('urn:schemas:httpmail:subject') }
    'from'    { @('urn:schemas:httpmail:fromname', 'urn:schemas:httpmail:fromemail') }
    'body'    { @('urn:schemas:httpmail:textdescription') }
    default   { @('urn:schemas:httpmail:subject', 'urn:schemas:httpmail:fromname', 'urn:schemas:httpmail:fromemail', 'urn:schemas:httpmail:textdescription') }
  }
  $like = '(' + (($cols | ForEach-Object { "`"$_`" LIKE '%$q%'" }) -join ' OR ') + ')'
  $likeFilter = Join-Filter (@($like) + $common)
  if (-not (Use-IndexedSearch $query)) { return , @($likeFilter) }

  $ci = '(' + (($cols | ForEach-Object { "`"$_`" ci_startswith '$q'" }) -join ' OR ') + ')'
  return , @((Join-Filter (@($ci) + $common)), $likeFilter)
}

function Add-FolderTree($folder, [int]$depth, [int]$maxDepth, $list) {
  foreach ($f in $folder.Folders) {
    if ($f.DefaultItemType -ne 0) { continue }  # mail folders only
    $list.Add([ordered]@{ path = Get-RelativePath $f; itemCount = $f.Items.Count; unreadCount = $f.UnReadItemCount })
    if ($depth + 1 -lt $maxDepth) { Add-FolderTree $f ($depth + 1) $maxDepth $list }
  }
}

function Add-MailFolders($folder, $list) {
  $list.Add($folder)
  foreach ($f in $folder.Folders) { if ($f.DefaultItemType -eq 0) { Add-MailFolders $f $list } }
}

function Get-AllSubfolders($folder) { $list = New-List; Add-MailFolders $folder $list; return , $list }

# Every mail folder of the mailbox minus Deleted Items / Junk. Walking the tree over COM
# takes seconds, so the list is cached (serve mode keeps it between requests).
function Get-MailboxFolders {
  $now = [DateTime]::UtcNow
  if (-not $script:folderCache -or ($now - $script:folderCache.at).TotalSeconds -gt $FolderCacheSeconds) {
    $skip = @($script:ns.GetDefaultFolder(3).EntryID, $script:ns.GetDefaultFolder(23).EntryID)
    $all = Get-AllSubfolders $script:root
    $folders = New-List
    for ($i = 1; $i -lt $all.Count; $i++) { if ($skip -notcontains $all[$i].EntryID) { $folders.Add($all[$i]) } }
    $script:folderCache = @{ at = $now; folders = $folders }
  }
  return , $script:folderCache.folders
}

function Invoke-Action([string]$action, [hashtable]$params) {
  if (-not $script:ns) { Connect-Outlook }
  $script:p = $params
  $ns = $script:ns
  $root = $script:root
  $data = switch ($action) {
    'status' {
      [ordered]@{
        connectionMode = $ns.ExchangeConnectionMode
        offline        = [bool]$ns.Offline
        accounts       = @($ns.Accounts | ForEach-Object { $_.SmtpAddress })
        store          = $ns.DefaultStore.DisplayName
      }
    }
    'list_folders' {
      $start = Resolve-Folder (Get-Param 'folder' '')
      if (-not (Get-Param 'folder' '')) { $start = $root }
      $tree = New-List
      Add-FolderTree $start 0 ([int](Get-Param 'maxDepth' 10)) $tree
      , $tree
    }
    'list_messages' {
      $folder = Resolve-Folder (Get-Param 'folder' 'Inbox')
      $filters = Build-Filters '' '' (Get-Param 'since' '') (Get-Param 'until' '') ([bool](Get-Param 'unreadOnly' $false))
      Get-Messages $folder $filters ([int](Get-Param 'limit' 20))
    }
    'search_messages' {
      $query = Get-Param 'query' ''
      $limit = [int](Get-Param 'limit' 20)
      $filters = Build-Filters $query (Get-Param 'field' 'all') (Get-Param 'since' '') (Get-Param 'until' '') ([bool](Get-Param 'unreadOnly' $false))
      $folderParam = Get-Param 'folder' ''
      $folders = if ($folderParam) {
        $f = Resolve-Folder $folderParam
        if ([bool](Get-Param 'includeSubfolders' $false)) { Get-AllSubfolders $f } else { @($f) }
      } else {
        Get-MailboxFolders  # whole mailbox, minus Deleted Items / Junk
      }
      $refs = New-List
      foreach ($f in $folders) { Add-TopItems $f $filters $limit $refs }
      Convert-Refs @($refs | Sort-Object time -Descending | Select-Object -First $limit)
    }
    'get_message' {
      $id = Get-Param 'id' ''
      if (-not $id) { throw 'id is required' }
      $m = $ns.GetItemFromID($id)
      $maxChars = [int](Get-Param 'maxBodyChars' 20000)
      $body = "$($m.Body)"
      $truncated = $body.Length -gt $maxChars
      if ($truncated) { $body = $body.Substring(0, $maxChars) }
      $recips = @{ 1 = @(); 2 = @(); 3 = @() }  # olTo / olCC / olBCC
      foreach ($r in $m.Recipients) {
        $recips[[int]$r.Type] += "$($r.Name) <$(Get-RecipientAddress $r)>"
      }
      $summary = Convert-Summary $m $m.Parent
      $summary['to'] = $recips[1]
      $summary['cc'] = $recips[2]
      $summary['sentOn'] = Format-Date $m.SentOn
      $summary['conversationTopic'] = $m.ConversationTopic
      $summary['attachments'] = @($m.Attachments | ForEach-Object { [ordered]@{ name = $_.FileName; size = $_.Size } })
      $summary['body'] = $body
      $summary['bodyTruncated'] = $truncated
      $summary
    }
    default { throw "Unknown action: $Action" }
  }
  # Wrapped in a hashtable so PowerShell does not unroll arrays on return.
  return @{ value = $data }
}

# COM errors meaning Outlook went away (closed / restarted) or a cached folder vanished.
$RetryableHResults = @(0x80010108, 0x800706BA, 0x800706BE, 0x8004010F) | ForEach-Object { [int]$_ }

function Invoke-WithRetry([string]$action, [hashtable]$params) {
  try {
    return Invoke-Action $action $params
  } catch {
    $e = $_.Exception
    while ($e -and -not ($e -is [System.Runtime.InteropServices.COMException])) { $e = $e.InnerException }
    if (-not $e -or $RetryableHResults -notcontains $e.HResult) { throw }
    Connect-Outlook  # reconnect + drop the folder cache, then retry once (every action is read-only)
    return Invoke-Action $action $params
  }
}

function Write-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}

if ($Action -eq 'serve') {
  # Requests arrive as ASCII JSON (non-ASCII is \u-escaped by the caller), so stdin encoding does not matter.
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
      $req = $line | ConvertFrom-Json
      $id = $req.id
      $result = Invoke-WithRetry $req.action (ConvertTo-ParamTable $req.params)
      Write-Json ([ordered]@{ id = $id; ok = $true; data = $result.value })
    } catch {
      Write-Json ([ordered]@{ id = $id; ok = $false; error = $_.Exception.Message })
    }
  }
  exit 0
}

try {
  $params = @{}
  if ($ParamsB64) { $params = ConvertTo-ParamTable ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ParamsB64)) | ConvertFrom-Json) }
  $result = Invoke-WithRetry $Action $params
  Write-Json ([ordered]@{ ok = $true; data = $result.value })
} catch {
  Write-Json ([ordered]@{ ok = $false; error = $_.Exception.Message })
}
