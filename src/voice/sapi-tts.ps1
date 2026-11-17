# Windows' own speech synthesiser (System.Speech) as a one-shot command.
# Writes $TextFile to a wav at $OutFile. Pure ASCII: Windows PowerShell reads
# a BOM-less script as ANSI, so any non-ASCII character here breaks parsing.
param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Voice = ''
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($Voice) {
        $names = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
        $chosen = $names | Where-Object { $_ -like "*$Voice*" } | Select-Object -First 1
        if (-not $chosen) { $chosen = $names | Select-Object -First 1 }
        if ($chosen) { $synth.SelectVoice($chosen) }
    }
    # UTF-8 so Chinese text reaches the synthesiser intact.
    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    $synth.SetOutputToWaveFile($OutFile)
    $synth.Speak($text)
    $synth.Dispose()
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
