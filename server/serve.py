"""Run the built editor API and its worker together for a private preview."""

import argparse
import os
import signal
import subprocess
import sys
import threading
import time


def run(port=8000, host="0.0.0.0"):
    stop = threading.Event()
    children = []
    previous_handlers = {}

    def request_stop(*_):
        stop.set()

    def send_signal(child, value):
        try:
            os.killpg(child.pid, value)
        except ProcessLookupError:
            pass

    result = 0
    try:
        for name in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[name] = signal.signal(name, request_stop)
        for module, arguments in [
            ("uvicorn", ["server.app:app", "--host", host, "--port", str(port)]),
            ("server.worker", []),
        ]:
            children.append(
                subprocess.Popen(
                    [sys.executable, "-m", module, *arguments],
                    start_new_session=True,
                )
            )
        print(f"Rototools preview: http://localhost:{port}", flush=True)
        while not stop.wait(0.25):
            for child in children:
                code = child.poll()
                if code is not None:
                    print(
                        f"Preview process exited ({code}); stopping both services.",
                        flush=True,
                    )
                    result = code or 1
                    stop.set()
                    break
    finally:
        # Also signal descendant FFmpeg processes if their parent already exited.
        for child in children:
            send_signal(child, signal.SIGTERM)
        deadline = time.monotonic() + 10
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                send_signal(child, signal.SIGKILL)
                child.wait()
        for name, handler in previous_handlers.items():
            signal.signal(name, handler)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8000")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    raise SystemExit(run(args.port, args.host))


if __name__ == "__main__":
    main()
