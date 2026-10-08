"""Readiness check; exits nonzero when inference dependencies are absent."""

import json
from server.providers import SAM2

provider = SAM2()
ready = provider.load()
print(json.dumps(provider.capabilities(), indent=2))
raise SystemExit(0 if ready else 1)
