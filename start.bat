@echo off
echo Starting SWE CS2 local server...
echo.
python --version >nul 2>&1 && (start "" "http://localhost:8080" && python -m http.server 8080 & goto end)
py --version >nul 2>&1      && (start "" "http://localhost:8080" && py -m http.server 8080 & goto end)
npx --version >nul 2>&1     && (start "" "http://localhost:8080" && npx serve -l 8080 . & goto end)
echo Neither Python nor Node.js found. Install either from python.org or nodejs.org.
pause
:end
