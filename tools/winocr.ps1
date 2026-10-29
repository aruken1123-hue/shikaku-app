# Windows 内蔵OCR（日本語）で、フォルダ内の p*.png を p*.win.txt にする（行は上から順に並べ直す）
# 使い方: powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/winocr.ps1 <フォルダ>（PowerShell 7 ではなく Windows 標準の powershell.exe で動かす）
# 日本語のOCRが入っていないPCでは止まる（設定 → 時刻と言語 → 言語 で日本語の「光学式文字認識」を入れる）。
# 読めなかったページは書き出さずに一覧にし、終了コード 1 で終わる（前回の結果を空で上書きしない）。
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ja'))
if ($null -eq $eng) { Write-Error '日本語のOCRがこのPCに入っていません。止めました'; exit 2 }
$pngs = @(Get-ChildItem -Path $Dir -Filter 'p*.png')
if ($pngs.Count -eq 0) { Write-Error "ページ画像（p*.png）がありません: $Dir"; exit 2 }
$failed = @()
foreach ($png in $pngs) {
  $stream = $null
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $raw = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $bmp = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($raw, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
    $raw.Dispose()
    $res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $bmp.Dispose()
    $rows = @($res.Lines | ForEach-Object {
      $w = @($_.Words)
      [pscustomobject]@{ Y = [math]::Round($w[0].BoundingRect.Y / 12); X = $w[0].BoundingRect.X; T = ($w | ForEach-Object { $_.Text }) -join '' }
    } | Sort-Object Y, X | ForEach-Object { $_.T })
    $out = Join-Path $png.DirectoryName ($png.BaseName + '.win.txt')
    [System.IO.File]::WriteAllLines($out, [string[]]$rows, [System.Text.UTF8Encoding]::new($false))
  } catch {
    $failed += $png.Name
    Write-Warning ("{0}: 読めませんでした（{1}）" -f $png.Name, $_.Exception.Message)
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}
if ($failed.Count) { Write-Error ("読めなかったページ: " + ($failed -join ', ')); exit 1 }
"done {0} pages: {1}" -f $pngs.Count, $Dir
