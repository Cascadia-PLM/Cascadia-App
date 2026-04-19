#!/bin/sh
# Start Xvfb virtual framebuffer in the background for offscreen OpenGL rendering
Xvfb :99 -screen 0 512x512x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

# Wait for Xvfb to be ready
sleep 1

# Trap signals to forward to children
cleanup() {
    kill $PYTHON_PID 2>/dev/null
    kill $XVFB_PID 2>/dev/null
    wait $PYTHON_PID 2>/dev/null
    exit $?
}
trap cleanup TERM INT

# Run Python in the foreground (not exec, so Xvfb stays alive)
python -m cad_converter.main "$@" &
PYTHON_PID=$!

# Wait for Python to exit
wait $PYTHON_PID
EXIT_CODE=$?

# Clean up Xvfb
kill $XVFB_PID 2>/dev/null
exit $EXIT_CODE
