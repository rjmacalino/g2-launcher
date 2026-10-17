# Speaks each benchmark question into a WAV file with the voice built into
# Windows (System.Speech, no download, no account), in the same format the
# glasses mic delivers: 16 kHz, mono, 16-bit. Called by bench/run.ts for
# any question that has no audio yet.
#
# Usage: powershell -File bench/tts.ps1 <questions.json> <output folder>
param(
  [Parameter(Mandatory = $true)][string]$QuestionsPath,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$questions = Get-Content -Raw -Path $QuestionsPath | ConvertFrom-Json
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

foreach ($q in $questions) {
  $path = Join-Path $OutDir ($q.id + '.wav')
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $voice.SetOutputToWaveFile($path, $format)
    $voice.Speak($q.text)
  }
  finally {
    $voice.Dispose()
  }
  Write-Output "spoke $($q.id)"
}
