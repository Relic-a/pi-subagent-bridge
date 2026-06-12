import json
import os
import subprocess
import sys
import time


def main() -> int:
    command = sys.argv[1]
    args = sys.argv[2:]
    env = dict(os.environ)
    if "PI_BRIDGE_PROBE_NO_DATA_DIR" not in env:
        env["PI_BRIDGE_DATA_DIR"] = env.get(
            "PI_BRIDGE_DATA_DIR",
            "/tmp/pi-subagent-bridge-python-probe",
        )
    proc = subprocess.Popen(
        [command, *args],
        cwd=os.environ.get("PI_BRIDGE_PROBE_CWD", "/tmp"),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin is not None
    assert proc.stdout is not None
    proc.stdin.write(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "python-probe", "version": "0.0.0"},
                },
            }
        )
        + "\n"
    )
    proc.stdin.flush()
    deadline = time.time() + 3
    line = ""
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line:
            break
        if proc.poll() is not None:
            break
        time.sleep(0.025)
    proc.terminate()
    stderr = proc.stderr.read() if proc.stderr is not None else ""
    if not line:
        print(f"no initialize response; returncode={proc.poll()}; stderr={stderr}")
        return 1
    print(line.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
