$ErrorActionPreference = "Stop"

$extensionRoot = Split-Path -Parent $PSScriptRoot
$audioDirectory = Join-Path $extensionRoot "public\audio"
$outputPath = Join-Path $audioDirectory "test.mp3"
$temporaryWave = Join-Path ([System.IO.Path]::GetTempPath()) ("douyin-english-" + [guid]::NewGuid().ToString("N") + ".wav")

New-Item -ItemType Directory -Path $audioDirectory -Force | Out-Null

try {
    Add-Type -AssemblyName System.Speech
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $englishVoice = $synthesizer.GetInstalledVoices() |
            Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like "en-*" } |
            Select-Object -First 1
        if ($englishVoice) {
            $synthesizer.SelectVoice($englishVoice.VoiceInfo.Name)
        }
        $synthesizer.SetOutputToWaveFile($temporaryWave, $format)
        $synthesizer.Speak("This is the Douyin English playback test. Pause, resume, seek, or swipe to verify audio sync.")
    }
    finally {
        $synthesizer.Dispose()
    }

    & node (Join-Path $PSScriptRoot "encode-test-audio.mjs") $temporaryWave $outputPath
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output "Generated $outputPath"
}
finally {
    if (Test-Path -LiteralPath $temporaryWave) {
        Remove-Item -LiteralPath $temporaryWave -Force
    }
}
