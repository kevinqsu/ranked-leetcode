#!/bin/sh
# Director runs this script to start the site. It must be executable
# (right-click > "Set executable" in the online editor, or chmod +x run.sh).
# Director provides PORT=80 and HOST=0.0.0.0 inside the container.
cd "$(dirname -- "$0")"
# Keep the V8 heap well inside Director's 100 MB container limit.
exec node --max-old-space-size=64 server/server.js
