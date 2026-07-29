#!/bin/bash

# --------------------------------------------------
# SmileClinic DMS - Local Development Runner
# --------------------------------------------------

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=================================================="
echo -e "       🏥  SmileClinic DMS - Local Server        "
echo -e "==================================================${NC}\n"

# Ensure we are in project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check Node.js installation
if ! command -v node &> /dev/null; then
    echo -e "${RED}[X] Node.js is not installed or not in PATH.${NC}"
    echo "Please install Node.js (https://nodejs.org) to run locally."
    exit 1
fi

NODE_VER=$(node -v)
echo -e "${GREEN}[✓] Node.js version:${NC} $NODE_VER"

# Check node_modules
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}[!] node_modules not found. Installing dependencies...${NC}"
    npm install
fi

# Default Port
PORT=${PORT:-5000}
LOCAL_URL="http://localhost:${PORT}"

# Free port if already in use
PID=$(lsof -ti:${PORT} 2>/dev/null)
if [ -n "$PID" ]; then
    echo -e "${YELLOW}[!] Port ${PORT} is currently in use (PID: $PID). Stopping process...${NC}"
    kill -9 $PID 2>/dev/null
    sleep 1
fi

echo -e "\n${GREEN}[✓] Starting local server at ${CYAN}${LOCAL_URL}${NC}"
echo -e "${YELLOW}    Press Ctrl+C to stop the server anytime.${NC}\n"

# Automatically open browser on macOS after 1.5 second delay
(sleep 1.5 && open "$LOCAL_URL" 2>/dev/null) &

# Run Node server
export PORT=$PORT
export NODE_ENV=development
node backend/src/server.js
