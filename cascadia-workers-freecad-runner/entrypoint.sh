#!/bin/sh
cleanup() {
    kill $PYTHON_PID 2>/dev/null
    wait $PYTHON_PID 2>/dev/null
    exit $?
}
trap cleanup TERM INT

python -m freecad_runner.main "$@" &
PYTHON_PID=$!
wait $PYTHON_PID
EXIT_CODE=$?
exit $EXIT_CODE
