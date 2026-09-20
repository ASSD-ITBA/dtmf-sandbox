@echo off
rem DTMF sandbox launcher — the worked detector. Double-click this file.
rem
rem Same app and same server as start.cmd; the only difference is the URL it
rem opens. ?solution=1 puts the detector from js/solution.js in the editor
rem instead of the empty one, and it outranks whatever code the browser had
rem saved from last time.
rem
rem Press Reset while it is open and the worked detector comes back, not the
rem empty starter. Use start.cmd for that one.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Solution %*

rem keep the window open if the server exits with an error
if errorlevel 1 pause
