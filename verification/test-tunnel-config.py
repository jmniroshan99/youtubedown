"""Check the merged optional ingress without printing effective environment secrets."""

import json
import subprocess

COMPOSE = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.local.yml", "-f", "docker-compose.tunnel.yml"]
result = subprocess.run(COMPOSE + ["config", "--format", "json"], capture_output=True, text=True)
if result.returncode:
    raise SystemExit("FAIL: Compose configuration could not be validated; private output withheld")
config = json.loads(result.stdout)
services = config["services"]
assert config["name"] == "videoflow"
assert config["networks"]["private"]["internal"] is True
for name in ["worker", "scheduler", "redis"]:
    assert set(services[name]["networks"]) == {"private"}
for name in ["api", "worker", "scheduler", "redis", "egress"]:
    assert not services[name].get("ports")
for name in ["api", "worker", "scheduler"]:
    assert services[name]["environment"]["MEDIA_PROXY"] == "http://egress:8080"
assert set(services["tunnel"]["networks"]) == {"local_ingress"}
assert services["tunnel"]["read_only"] is True
assert services["tunnel"]["cap_drop"] == ["ALL"]
assert "@sha256:" in services["tunnel"]["image"]
assert services["local-gateway"]["ports"][0]["host_ip"] == "127.0.0.1"
assert "https://youtubedownl.netlify.app" in services["api"]["environment"]["ALLOWED_ORIGINS"].split(",")
print("PASS: private service networks/ports, mandatory source proxy, pinned connector and exact frontend CORS")
