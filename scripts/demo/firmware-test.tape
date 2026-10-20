# Records docs/media/firmware-test.gif: the headless firmware test CLI on the three
# example scenarios. Run from the repository root with g++ on PATH:
#   npm run demo:terminal
# Needs VHS (https://github.com/charmbracelet/vhs; Windows: winget install charmbracelet.vhs
# tsl0922.ttyd Gyan.FFmpeg). The shell below is Windows PowerShell; on macOS or Linux set
# Shell to "bash" and replace the prompt line with: PS1='cortex> '
#
# Playback is 3x. Most of the real run is g++ compiling each scenario, and the
# README says the GIF is sped up and how long the real run took.

Output docs/media/firmware-test.gif

# VHS cannot parse "Require g++"; the CLI itself stops with a clear error without a compiler.
Require npm

Set Shell "powershell"
Set FontSize 16
Set Width 1100
Set Height 330
Set Padding 20
Set Theme "Builtin Dark"
Set PlaybackSpeed 3
Set TypingSpeed 120ms
Set WaitTimeout 5m

Hide
Type "function prompt { 'cortex> ' }; Clear-Host"
Enter
Sleep 1s
Show

Sleep 1.5s
Type "npm run firmware:test"
Sleep 1.5s
Enter
Wait+Screen /Reports:/
Sleep 1.5s
Type "'exit code: ' + $LASTEXITCODE"
Enter
Sleep 9s
