#!/bin/bash
echo "Starting SWE CS2 local server..."
URL="http://localhost:8080"
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true
command -v python3 &>/dev/null && exec python3 -m http.server 8080
command -v python  &>/dev/null && exec python  -m SimpleHTTPServer 8080
command -v npx     &>/dev/null && exec npx serve -l 8080 .
echo "Error: install Python (python.org) or Node.js (nodejs.org) first."
