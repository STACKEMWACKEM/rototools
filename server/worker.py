import argparse
import json
import logging
import signal
import shutil
import threading
import time
from . import media, render, store
from .providers import SAM2


def work_once(provider, worker):
    job = store.claim(worker)
    if not job:
        return False
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(5):
            with store.db() as c:
                c.execute(
                    "UPDATE jobs SET lease=? WHERE id=? AND worker=? AND state IN ('running','cancel_requested')",
                    (time.time() + 45, job["id"], worker),
                )

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        store.check(job)
        payload = json.loads(job["payload"])
        if job["kind"] == "prepare":
            result = media.prepare(
                job, store.owned("assets", payload["asset"], job["owner"])
            )
        elif job["kind"] == "export":
            result = render.render(job)
        elif job["kind"] == "track":
            result = provider.process(job)
        else:
            raise ValueError("UNKNOWN_JOB_TYPE")
        store.check(job)
        store.finish(job, "completed", result)
    except InterruptedError:
        store.finish(job, "canceled", error="CANCELED")
    except (ValueError, KeyError) as e:
        store.finish(job, "failed", error=str(e).strip("'"))
    except Exception:
        logging.getLogger(__name__).exception("Processing job %s failed", job["id"])
        store.finish(job, "failed", error="PROCESSING_FAILED")
    finally:
        stop.set()
        thread.join(timeout=1)
        if job["project"]:
            with store.db() as c:
                row = c.execute(
                    "SELECT deleted FROM projects WHERE id=?", (job["project"],)
                ).fetchone()
            if not row or row["deleted"]:
                shutil.rmtree(store.DATA / "jobs" / job["id"], ignore_errors=True)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    store.init()
    provider = SAM2()
    provider.load()
    worker = store.uid()
    formats = render.verify_encoders(store.DATA / "selftest")

    def ready():
        with store.db() as c:
            for name, value in [
                ("model", provider.capabilities()),
                ("exports", formats),
            ]:
                c.execute(
                    "INSERT OR REPLACE INTO readiness VALUES(?,?,?)",
                    (name, json.dumps(value), time.time()),
                )

    ready()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    def keep_ready():
        # Readiness must remain fresh while a long model/export job is running.
        while not stop.wait(15):
            ready()

    readiness = threading.Thread(target=keep_ready, daemon=True)
    readiness.start()
    last = 0
    try:
        while not stop.is_set():
            if time.time() - last > 15:
                store.cleanup()
                last = time.time()
            used = work_once(provider, worker)
            if args.once:
                break
            if not used:
                stop.wait(0.5)
    finally:
        stop.set()
        readiness.join(timeout=2)


if __name__ == "__main__":
    main()
