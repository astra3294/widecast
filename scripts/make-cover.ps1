# 生成文章配图(抖音图文封面):深色渐变 + 标题
Add-Type -AssemblyName System.Drawing
$w = 1080; $h = 1440
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# 渐变背景
$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255,16,24,44), [System.Drawing.Color]::FromArgb(255,48,24,72), 90.0)
$g.FillRectangle($brush, $rect)

# 顶部小标
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei', 34, [System.Drawing.FontStyle]::Bold)
$smallBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200,255,255,255))
$g.DrawString('AI 内容分发', $fontSmall, $smallBrush, 90, 300)

# 主标题两行
$fontBig = New-Object System.Drawing.Font('Microsoft YaHei', 110, [System.Drawing.FontStyle]::Bold)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.DrawString('自媒体矩阵', $fontBig, $white, 90, 520)
$g.DrawString('我交给 AI 管了', $fontBig, $white, 90, 700)

# 分隔线
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160,255,255,255), 4)
$g.DrawLine($pen, 90, 900, $w - 90, 900)

# 底部署名
$fontFoot = New-Object System.Drawing.Font('Microsoft YaHei', 40, [System.Drawing.FontStyle]::Regular)
$footBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180,255,255,255))
$g.DrawString('widecast', $fontFoot, $footBrush, 90, 980)

$out = 'E:\自媒体\cover-article.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved: $out"
Get-Item $out | Select-Object Length