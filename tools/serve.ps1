param([int]$Port = 8777)
$root = Split-Path -Parent $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output ("serving on http://localhost:" + $Port)
$enc = New-Object System.Text.UTF8Encoding($false)

function Get-Mime($ext){
  switch($ext){
    '.js'   { return 'application/javascript; charset=utf-8' }
    '.html' { return 'text/html; charset=utf-8' }
    '.css'  { return 'text/css; charset=utf-8' }
    '.json' { return 'application/json; charset=utf-8' }
    '.md'   { return 'text/plain; charset=utf-8' }
    default { return 'application/octet-stream' }
  }
}

while($listener.IsListening){
  $ctx = $listener.GetContext()
  try{
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if($rel -eq ''){ $rel = 'index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if(-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)){
      $ctx.Response.StatusCode = 403; $ctx.Response.Close(); continue
    }
    $ctx.Response.Headers.Add('Access-Control-Allow-Origin', '*')
    if(Test-Path -LiteralPath $full -PathType Leaf){
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentType = Get-Mime ([System.IO.Path]::GetExtension($full).ToLower())
      $ctx.Response.StatusCode = 200
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $ctx.Response.Close()
    } else {
      $ctx.Response.StatusCode = 404
      $b = $enc.GetBytes('not found: ' + $rel)
      $ctx.Response.OutputStream.Write($b, 0, $b.Length)
      $ctx.Response.Close()
    }
  } catch {
    try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
  }
}
