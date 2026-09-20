<#
    serve.ps1 — minimal static file server for the DTMF sandbox.

    The app needs an http:// origin (Web Workers and WebAssembly do not work
    from file://). This uses raw sockets rather than HttpListener so it never
    needs an URL ACL reservation or an elevated prompt.

        powershell -ExecutionPolicy Bypass -File serve.ps1
        powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8080 -NoBrowser
        powershell -ExecutionPolicy Bypass -File serve.ps1 -Solution

    -Solution opens the app with the worked detector in the editor instead of
    the empty one. It only changes the URL that is opened; the server serves
    the same folder either way.
#>

[CmdletBinding()]
param(
    [int]$Port = 8000,
    [switch]$NoBrowser,
    [switch]$Solution
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.py'   = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.wasm' = 'application/wasm'
    '.zip'  = 'application/zip'
    '.whl'  = 'application/zip'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
    $listener.Start()
} catch {
    Write-Host "Could not listen on port $Port : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Try another one, e.g.  -Port 8080" -ForegroundColor Yellow
    exit 1
}

$url = "http://localhost:$Port/"
if ($Solution) { $url += "?solution=1" }
Write-Host ""
Write-Host "  DTMF sandbox" -ForegroundColor Cyan
Write-Host "  serving $root"
Write-Host "  at      $url" -ForegroundColor Green
if ($Solution) { Write-Host "  editor  the worked detector" -ForegroundColor Yellow }
Write-Host "  Ctrl+C to stop"
Write-Host ""

if (-not $NoBrowser) { Start-Process $url | Out-Null }

function Send-Response {
    param($Stream, [int]$Code, [string]$Status, [string]$Type, [byte[]]$Body,
          [string]$Cache = 'no-cache')

    $head = "HTTP/1.1 $Code $Status`r`n" +
            "Content-Type: $Type`r`n" +
            "Content-Length: $($Body.Length)`r`n" +
            "Cache-Control: $Cache`r`n" +
            "Connection: close`r`n`r`n"
    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($headBytes, 0, $headBytes.Length)
    if ($Body.Length) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 5000
            $stream.WriteTimeout = 15000

            # request line is all we need
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) { continue }

            $parts = $requestLine -split ' '
            $target = if ($parts.Length -ge 2) { $parts[1] } else { '/' }
            $target = ($target -split '\?')[0]
            $target = [System.Uri]::UnescapeDataString($target)
            if ($target -eq '/' -or $target -eq '') { $target = '/index.html' }

            $relative = $target.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            try {
                $full = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
            } catch {
                # characters Windows cannot express in a path (':', '*', '?', …)
                Send-Response $stream 400 'Bad Request' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('400 bad path'))
                Write-Host "400 $target" -ForegroundColor Yellow
                continue
            }

            # keep requests inside the app directory
            if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-Response $stream 403 'Forbidden' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('403'))
                Write-Host "403 $target" -ForegroundColor Red
                continue
            }

            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $body = [System.IO.File]::ReadAllBytes($full)
                $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
                # vendor/ is versioned and never edited in place: let the browser keep it,
                # otherwise every reload re-downloads ~16 MB of Pyodide
                $cache = if ($target -like '/vendor/*') { 'public, max-age=31536000, immutable' } else { 'no-cache' }
                Send-Response $stream 200 'OK' $type $body $cache
                Write-Host ("200 {0,-40} {1,8} B" -f $target, $body.Length) -ForegroundColor DarkGray
            } else {
                Send-Response $stream 404 'Not Found' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('404 not found'))
                Write-Host "404 $target" -ForegroundColor Yellow
            }
        } catch {
            # a browser dropping a connection is normal; keep serving
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
    Write-Host "`nstopped." -ForegroundColor Cyan
}
