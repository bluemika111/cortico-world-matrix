# Shrinks one image so it can be sent to a model without burning context.
# Writes a JPEG at $OutPath. Pure ASCII: Windows PowerShell reads a BOM-less
# script as ANSI, so any non-ASCII character here breaks parsing.
param(
    [Parameter(Mandatory = $true)][string]$InPath,
    [Parameter(Mandatory = $true)][string]$OutPath,
    [int]$MaxEdge = 1568,
    [int]$Quality = 82
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Drawing

    # FromStream avoids the file lock FromFile keeps on the source.
    $stream = [System.IO.File]::OpenRead($InPath)
    try {
        $img = [System.Drawing.Image]::FromStream($stream)
        try {
            $w = $img.Width
            $h = $img.Height
            if ($w -le 0 -or $h -le 0) { throw 'empty image' }

            $scale = [Math]::Min(1.0, [Math]::Min($MaxEdge / $w, $MaxEdge / $h))
            $nw = [int][Math]::Max(1, [Math]::Round($w * $scale))
            $nh = [int][Math]::Max(1, [Math]::Round($h * $scale))

            $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
            try {
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                try {
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $g.DrawImage($img, 0, 0, $nw, $nh)
                } finally { $g.Dispose() }

                $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                    Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
                if (-not $codec) { throw 'no jpeg encoder' }

                $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
                $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                    [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
                $bmp.Save($OutPath, $codec, $params)
            } finally { $bmp.Dispose() }
        } finally { $img.Dispose() }
    } finally { $stream.Dispose() }

    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
