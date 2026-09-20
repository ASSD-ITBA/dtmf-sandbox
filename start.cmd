@echo off
rem DTMF sandbox launcher — double-click this file.
rem
rem The app cannot be opened by double-clicking index.html: browsers block Web
rem Workers and WebAssembly on file:// URLs, so Python would never start. This
rem serves the folder over http://localhost and opens it in your browser.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*

rem keep the window open if the server exits with an error
if errorlevel 1 pause
