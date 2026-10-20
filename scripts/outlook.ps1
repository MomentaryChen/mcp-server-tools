# Read-only Outlook (classic) access via COM, used by server-outlook.js.
# Usage: outlook.ps1 <action> <base64-utf8-json-params>
# Writes a single JSON document to stdout: { ok: true, data } or { ok: false, error }.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$ParamsB64 = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$p = @{}
if ($ParamsB64) {
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ParamsB64))
  $obj = $json | ConvertFrom-Json
  foreach ($prop in $obj.PSObject.Properties) { $p[$prop.Name] = $prop.Value }
}

function Get-Param($name, $default) { if ($p.ContainsKey($name) -and $null -ne $p[$name] -and "$($p[$name])" -ne '') { $p[$name] } else { $default } }

$olMail = 43
$defaultFolders = @{ 'inbox' = 6; 'sent' = 5; 'sent items' = 5; 'drafts' = 16; 'deleted' = 3; 'deleted items' = 3; 'junk' = 23; 'junk email' = 23; 'outbox' = 4 }

$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$root = $ns.GetDefaultFolder(6).Parent

function Get-RelativePath($folder) { "$($folder.FolderPath)" -replace '^\\\\[^\\]+\\', '' -replace '\\', '/' }

function Resolve-Folder([string]$path) {
  if (-not $path) { return $ns.GetDefaultFolder(6) }
  $parts = $path.Trim('/', '\') -split '[/\\]'
  $first = $parts[0].ToLower()
  if ($defaultFolders.ContainsKey($first)) { $f = $ns.GetDefaultFolder($defaultFolders[$first]); $rest = $parts | Select-Object -Skip 1 }
  else { $f = $root; $rest = $parts }
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

function Get-Messages($folder, [string]$filter, [int]$limit) {
  $items = $folder.Items
  if ($filter) { $items = $items.Restrict($filter) }
  $items.Sort('[ReceivedTime]', $true)
  $out = @()
  foreach ($m in $items) {
    if ($out.Count -ge $limit) { break }
    try { $out += (Convert-Summary $m $folder) } catch {}  # skip items that fail to load (e.g. corrupted / protected)
  }
  return , $out
}

function Build-Filter([string]$query, [string]$field, [string]$since, [string]$until, [bool]$unreadOnly) {
  $clauses = @()
  if ($query) {
    $q = Escape-Dasl $query
    $cols = switch ($field) {
      'subject' { @('urn:schemas:httpmail:subject') }
      'from'    { @('urn:schemas:httpmail:fromname', 'urn:schemas:httpmail:fromemail') }
      'body'    { @('urn:schemas:httpmail:textdescription') }
      default   { @('urn:schemas:httpmail:subject', 'urn:schemas:httpmail:fromname', 'urn:schemas:httpmail:fromemail', 'urn:schemas:httpmail:textdescription') }
    }
    $clauses += '(' + (($cols | ForEach-Object { "`"$_`" LIKE '%$q%'" }) -join ' OR ') + ')'
  }
  if ($since) { $clauses += "`"urn:schemas:httpmail:datereceived`" >= '$(([datetime]$since).ToUniversalTime().ToString('yyyy-MM-dd HH:mm'))'" }
  if ($until) { $clauses += "`"urn:schemas:httpmail:datereceived`" < '$(([datetime]$until).ToUniversalTime().ToString('yyyy-MM-dd HH:mm'))'" }
  if ($unreadOnly) { $clauses += '"urn:schemas:httpmail:read" = 0' }
  if ($clauses.Count -eq 0) { return '' }
  return '@SQL=' + ($clauses -join ' AND ')
}

function Get-FolderTree($folder, [int]$depth, [int]$maxDepth) {
  $list = @()
  foreach ($f in $folder.Folders) {
    if ($f.DefaultItemType -ne 0) { continue }  # mail folders only
    $list += [ordered]@{ path = Get-RelativePath $f; itemCount = $f.Items.Count; unreadCount = $f.UnReadItemCount }
    if ($depth + 1 -lt $maxDepth) { $list += Get-FolderTree $f ($depth + 1) $maxDepth }
  }
  return $list
}

function Get-AllSubfolders($folder) {
  $list = @($folder)
  foreach ($f in $folder.Folders) { if ($f.DefaultItemType -eq 0) { $list += Get-AllSubfolders $f } }
  return $list
}

try {
  $data = switch ($Action) {
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
      , (Get-FolderTree $start 0 ([int](Get-Param 'maxDepth' 10)))
    }
    'list_messages' {
      $folder = Resolve-Folder (Get-Param 'folder' 'Inbox')
      $filter = Build-Filter '' '' (Get-Param 'since' '') (Get-Param 'until' '') ([bool](Get-Param 'unreadOnly' $false))
      Get-Messages $folder $filter ([int](Get-Param 'limit' 20))
    }
    'search_messages' {
      $query = Get-Param 'query' ''
      $limit = [int](Get-Param 'limit' 20)
      $filter = Build-Filter $query (Get-Param 'field' 'all') (Get-Param 'since' '') (Get-Param 'until' '') ([bool](Get-Param 'unreadOnly' $false))
      $folderParam = Get-Param 'folder' ''
      $folders = if ($folderParam) {
        $f = Resolve-Folder $folderParam
        if ([bool](Get-Param 'includeSubfolders' $false)) { Get-AllSubfolders $f } else { @($f) }
      } else {
        # Whole mailbox, minus Deleted Items / Junk
        $skip = @($ns.GetDefaultFolder(3).EntryID, $ns.GetDefaultFolder(23).EntryID)
        Get-AllSubfolders $root | Select-Object -Skip 1 | Where-Object { $skip -notcontains $_.EntryID }
      }
      $all = @()
      foreach ($f in $folders) { $all += (Get-Messages $f $filter $limit) }
      , @($all | Sort-Object { $_.receivedTime } -Descending | Select-Object -First $limit)
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
  [ordered]@{ ok = $true; data = $data } | ConvertTo-Json -Depth 8 -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
