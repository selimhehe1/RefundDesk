#!/usr/bin/env python3

"""Stateful fake Docker/systemd/ss surface for ADR 0035 Linux tests."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any


STATE_PATH = Path(os.environ["REFUNDDESK_CONTAINMENT_FAKE_STATE"])


def load_state() -> dict[str, Any]:
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save_state(state: dict[str, Any]) -> None:
    temporary = STATE_PATH.with_name(f".{STATE_PATH.name}.{os.getpid()}")
    temporary.write_text(
        json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, STATE_PATH)


def record(state: dict[str, Any], operation: str) -> None:
    state.setdefault("operations", []).append(operation)


def clean_arguments(arguments: list[str]) -> list[str]:
    return [argument for argument in arguments if argument != "--"]


def find_container(state: dict[str, Any], value: str) -> dict[str, Any]:
    normalized = value.removeprefix("/")
    for container in state["containers"]:
        if container["Id"] == value or container["Name"].removeprefix("/") == normalized:
            return container
    raise KeyError(value)


def docker_container_ls(state: dict[str, Any], arguments: list[str]) -> int:
    include_all = "--all" in arguments
    filters: list[str] = []
    for index, argument in enumerate(arguments):
        if argument == "--filter" and index + 1 < len(arguments):
            filters.append(arguments[index + 1])
    selected = []
    for container in state["containers"]:
        if not include_all and not container["State"]["Running"]:
            continue
        accepted = True
        for filter_value in filters:
            if filter_value.startswith("label="):
                label_filter = filter_value.removeprefix("label=")
                name, expected = label_filter.split("=", 1)
                if container["Config"]["Labels"].get(name) != expected:
                    accepted = False
            elif filter_value.startswith("name=^/"):
                expected = filter_value.removeprefix("name=^/").removesuffix("$")
                if container["Name"] != f"/{expected}":
                    accepted = False
        if accepted:
            selected.append(container)
    if selected:
        sys.stdout.write("\n".join(container["Id"] for container in selected) + "\n")
    return 0


def reservation_container(state: dict[str, Any], arguments: list[str]) -> dict[str, Any]:
    labels: dict[str, str] = {}
    name = "refunddesk-database-owner-job"
    for index, argument in enumerate(arguments):
        if argument == "--name":
            name = arguments[index + 1]
        elif argument == "--label":
            key, value = arguments[index + 1].split("=", 1)
            labels[key] = value
    identifier = state.get("nextContainerId", "9" * 64)
    state["nextContainerId"] = f"{int(identifier, 16) + 1:064x}"[-64:]
    reference = arguments[-1]
    image = state["images"][reference]
    return {
        "Id": identifier,
        "Name": f"/{name}",
        "Image": image["Id"],
        "Config": {"Image": reference, "User": "", "Labels": labels, "Env": []},
        "HostConfig": {
            "RestartPolicy": {"Name": "no"},
            "PortBindings": {},
            "NetworkMode": "none",
            "ReadonlyRootfs": True,
            "Tmpfs": {"/var/lib/postgresql": "rw,nosuid,nodev,noexec,size=65536"},
        },
        "State": {
            "Running": False,
            "Status": "created",
            "ExitCode": 0,
            "Error": "",
            "Health": None,
        },
        "Mounts": [],
    }


def run_docker(arguments: list[str]) -> int:
    state = load_state()
    arguments = clean_arguments(arguments)
    if arguments[:2] == ["image", "inspect"]:
        reference = arguments[-1]
        image = state["images"].get(reference)
        if image is None:
            return 1
        sys.stdout.write(json.dumps([image], separators=(",", ":")) + "\n")
        return 0
    if arguments[:2] == ["container", "ls"]:
        return docker_container_ls(state, arguments[2:])
    if arguments and arguments[0] == "inspect":
        try:
            container = find_container(state, arguments[-1])
        except KeyError:
            return 1
        sys.stdout.write(json.dumps([container], separators=(",", ":")) + "\n")
        return 0
    if arguments and arguments[0] == "update":
        try:
            container = find_container(state, arguments[-1])
        except KeyError:
            return 1
        container["HostConfig"]["RestartPolicy"]["Name"] = "no"
        record(state, f"docker:update:{container['Config']['Labels'].get('com.docker.compose.service', 'unknown')}")
        save_state(state)
        sys.stdout.write(container["Id"] + "\n")
        return 0
    if arguments and arguments[0] in {"stop", "kill"}:
        try:
            container = find_container(state, arguments[-1])
        except KeyError:
            return 1
        service = container["Config"]["Labels"].get("com.docker.compose.service", "unknown")
        container["State"]["Running"] = False
        container["State"]["Status"] = "exited"
        if service == "caddy" and not state.get("stickyListeners", False):
            for key in state["listeners"]:
                state["listeners"][key] = False
        record(state, f"docker:{arguments[0]}:{service}")
        save_state(state)
        sys.stdout.write(container["Id"] + "\n")
        return 0
    if arguments and arguments[0] == "exec":
        record(state, "docker:exec:finance-snapshot")
        save_state(state)
        sys.stdout.write(state["financeLine"] + "\n")
        return 0
    if arguments and arguments[0] == "rm":
        target = arguments[-1]
        try:
            container = find_container(state, target)
        except KeyError:
            return 1
        state["containers"].remove(container)
        record(state, f"docker:rm:{container['Config']['Labels'].get('com.docker.compose.service', 'unknown')}")
        save_state(state)
        sys.stdout.write(container["Id"] + "\n")
        return 0
    if arguments and arguments[0] == "rename":
        try:
            container = find_container(state, arguments[1])
        except KeyError:
            return 1
        container["Name"] = f"/{arguments[2].removeprefix('/')}"
        record(state, "docker:rename:database-owner")
        save_state(state)
        return 0
    if arguments and arguments[0] == "create":
        container = reservation_container(state, arguments)
        state["containers"].append(container)
        record(state, "docker:create:database-owner-reservation")
        save_state(state)
        sys.stdout.write(container["Id"] + "\n")
        return 0
    return 2


def run_systemctl(arguments: list[str]) -> int:
    state = load_state()
    if state.get("systemdUnavailable", False) and arguments and arguments[0] == "show":
        return 1
    if arguments and arguments[0] == "stop":
        unit = arguments[1]
        state["units"][unit] = "inactive"
        record(state, f"systemctl:stop:{unit}")
        save_state(state)
        return 0
    if arguments and arguments[0] == "show":
        unit = arguments[1]
        if unit not in state["units"]:
            return 1
        sys.stdout.write(state["units"][unit] + "\n")
        return 0
    if arguments and arguments[0] == "list-units":
        for unit in state.get("releaseUnits", []):
            sys.stdout.write(f"{unit} loaded active running fixture\n")
        return 0
    return 2


def run_ss(arguments: list[str]) -> int:
    state = load_state()
    if state.get("listenerUnavailable", False):
        return 1
    protocol = "tcp" if "-ltn" in arguments else "udp"
    expression = arguments[-1]
    match = re.search(r":(80|443)", expression)
    if match is None:
        return 2
    key = f"{protocol}{match.group(1)}"
    if state["listeners"].get(key, False):
        sys.stdout.write(f"LISTEN fixture {protocol} {match.group(1)}\n")
    return 0


def main() -> int:
    command = Path(sys.argv[0]).name
    if command == "docker":
        return run_docker(sys.argv[1:])
    if command == "systemctl":
        return run_systemctl(sys.argv[1:])
    if command == "ss":
        return run_ss(sys.argv[1:])
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
