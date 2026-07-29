#!/usr/bin/env python3

"""Fail-closed, atomic journal for RefundDesk application-key transitions."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

REVISION = re.compile(r"^[0-9a-f]{40}$")
FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
STATES = {"legacy", "staged", "active", "rollback", "retired"}
FAMILIES = ("approvalAttestation", "field", "proof")
VERSIONS = ("v1", "v2")
QUIESCE_OPERATIONS = {"backup", "retention"}
ENV_KEYS = {
    "field": (
        "REFUNDDESK_FIELD_ENCRYPTION_KEY_V1",
        "REFUNDDESK_FIELD_ENCRYPTION_KEY_V2",
    ),
    "proof": ("REFUNDDESK_PROOF_HMAC_KEY_V1", "REFUNDDESK_PROOF_HMAC_KEY_V2"),
    "approvalAttestation": (
        "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V1",
        "REFUNDDESK_APPROVAL_ATTESTATION_HMAC_KEY_V2",
    ),
}


class ContractError(Exception):
    pass


def require_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise ContractError(f"{label} has an invalid shape")
    return value


def validate_fingerprints(value: Any, label: str) -> dict[str, Any]:
    fingerprints = require_keys(value, set(FAMILIES), label)
    for family in FAMILIES:
        versions = require_keys(
            fingerprints[family], set(VERSIONS), f"{label}.{family}"
        )
        for version in VERSIONS:
            fingerprint = versions[version]
            if fingerprint is not None and (
                not isinstance(fingerprint, str)
                or FINGERPRINT.fullmatch(fingerprint) is None
            ):
                raise ContractError(f"{label}.{family}.{version} is invalid")
    return fingerprints


def expected_presence(state: str) -> tuple[bool, bool]:
    if state == "legacy":
        return True, False
    if state in {"staged", "active", "rollback"}:
        return True, True
    if state == "retired":
        return False, True
    raise ContractError("invalid application-key rotation state")


def validate_side(value: Any, label: str, *, target: bool) -> dict[str, Any]:
    side = require_keys(
        value, {"fingerprints", "recorded", "revision", "states"}, label
    )
    revision = side["revision"]
    if revision is not None and (
        not isinstance(revision, str) or REVISION.fullmatch(revision) is None
    ):
        raise ContractError(f"{label}.revision is invalid")
    if target and revision is None:
        raise ContractError("target revision cannot be null")
    if not isinstance(side["recorded"], bool):
        raise ContractError(f"{label}.recorded is invalid")

    states = require_keys(side["states"], set(FAMILIES), f"{label}.states")
    fingerprints = validate_fingerprints(
        side["fingerprints"], f"{label}.fingerprints"
    )
    for family in FAMILIES:
        state_value = states[family]
        if revision is None:
            if state_value is not None or any(
                fingerprints[family][version] is not None for version in VERSIONS
            ):
                raise ContractError(f"{label} fresh state contains key material")
            continue
        if not isinstance(state_value, str) or state_value not in STATES:
            raise ContractError(f"{label}.states.{family} is invalid")
        v1_expected, v2_expected = expected_presence(state_value)
        if (fingerprints[family]["v1"] is not None) != v1_expected or (
            fingerprints[family]["v2"] is not None
        ) != v2_expected:
            raise ContractError(
                f"{label}.fingerprints.{family} does not match its lifecycle state"
            )

    if revision is None and side["recorded"]:
        raise ContractError(f"{label} fresh state cannot be recorded")
    if target and not side["recorded"]:
        raise ContractError("target state must be recorded")
    return side


def validate_journal(value: Any) -> dict[str, Any]:
    journal = require_keys(
        value, {"from", "schemaVersion", "status", "to"}, "journal"
    )
    if journal["schemaVersion"] != 1 or journal["status"] != "in_progress":
        raise ContractError("journal version or status is invalid")
    validate_side(journal["from"], "journal.from", target=False)
    validate_side(journal["to"], "journal.to", target=True)
    return journal


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("JSON control file is unreadable or invalid") from error


def assert_secure_journal(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ContractError("transition journal cannot be inspected") from error
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise ContractError("transition journal is not a regular file")
    if os.name != "nt" and (
        metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077
    ):
        raise ContractError("transition journal ownership or mode is unsafe")


def fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def assert_root_control_path(path: Path, *, secret: bool = False) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ContractError("durability path cannot be inspected") from error
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise ContractError("durability path is not a regular file")
    if os.name != "nt" and (
        metadata.st_uid != os.geteuid()
        or metadata.st_mode & (0o077 if secret else 0o022)
    ):
        raise ContractError("durability path ownership or mode is unsafe")
    return metadata


def assert_root_control_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ContractError("durability directory cannot be inspected") from error
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise ContractError("durability directory is not a real directory")
    if os.name != "nt" and (
        metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022
    ):
        raise ContractError("durability directory ownership or mode is unsafe")


def fsync_regular_file(path: Path) -> None:
    # Windows does not provide the same POSIX durability contract for an
    # O_RDONLY descriptor. The production launchers run on Linux; keeping the
    # Windows test path as a no-op mirrors fsync_directory's portability guard.
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_replace(source: Path, target: Path, mode: int) -> None:
    if source.parent.resolve() != target.parent.resolve():
        raise ContractError("durable replacement must remain in one directory")
    assert_root_control_directory(target.parent)
    assert_root_control_path(source)
    try:
        # Production launchers run this helper as root and normalize both
        # ownership fields. Contract tests exercise the same durability path
        # unprivileged, where the precondition already binds the source to euid.
        if os.name != "nt" and os.geteuid() == 0:
            os.chown(source, 0, 0)
        os.chmod(source, mode)
        fsync_regular_file(source)
        os.replace(source, target)
        fsync_regular_file(target)
        fsync_directory(target.parent)
    except OSError as error:
        raise ContractError("durable replacement failed") from error


def durable_symlink(target: Path, value: str) -> None:
    if not value.startswith("/"):
        raise ContractError("durable symlink target must be absolute")
    assert_root_control_directory(target.parent)
    temporary_name = ""
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.", dir=target.parent
        )
        os.close(descriptor)
        os.unlink(temporary_name)
        os.symlink(value, temporary_name)
        os.replace(temporary_name, target)
        fsync_directory(target.parent)
    except OSError as error:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
        raise ContractError("durable symlink replacement failed") from error


def durable_unlink(target: Path) -> None:
    assert_root_control_directory(target.parent)
    try:
        if target.exists() or target.is_symlink():
            metadata = target.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                raise ContractError("durable unlink refuses a directory")
            target.unlink()
        fsync_directory(target.parent)
    except OSError as error:
        raise ContractError("durable unlink failed") from error


def fsync_paths(paths: list[Path], directories: list[Path]) -> None:
    seen_directories: set[Path] = set()
    for path in paths:
        assert_root_control_path(path, secret=True)
        try:
            fsync_regular_file(path)
        except OSError as error:
            raise ContractError("configured file could not be synchronized") from error
        seen_directories.add(path.parent)
    seen_directories.update(directories)
    for directory in sorted(seen_directories, key=lambda value: len(value.parts), reverse=True):
        assert_root_control_directory(directory)
        try:
            fsync_directory(directory)
        except OSError as error:
            raise ContractError("configured directory could not be synchronized") from error


def fsync_tree(root: Path) -> None:
    assert_root_control_directory(root)
    directories: list[Path] = []
    try:
        for current, directory_names, file_names in os.walk(root):
            current_path = Path(current)
            directories.append(current_path)
            for name in directory_names:
                assert_root_control_directory(current_path / name)
            for name in file_names:
                path = current_path / name
                assert_root_control_path(path)
                fsync_regular_file(path)
        for directory in sorted(
            directories, key=lambda value: len(value.parts), reverse=True
        ):
            fsync_directory(directory)
    except OSError as error:
        raise ContractError("source tree durability synchronization failed") from error


def validate_maintenance(environment_path: Path, password_path: Path) -> None:
    expected_names = {
        "NODE_ENV",
        "REFUNDDESK_MAINTENANCE_DATABASE_URL",
        "REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1",
        "REFUNDDESK_RETENTION_BATCH_SIZE",
        "REFUNDDESK_RETENTION_SCOPE",
    }
    assert_root_control_path(environment_path, secret=True)
    assert_root_control_path(password_path, secret=True)
    try:
        raw_environment = environment_path.read_text(encoding="utf-8")
        raw_password = password_path.read_text(encoding="utf-8")
        if "\r" in raw_environment or "\r" in raw_password:
            raise ValueError
        values: dict[str, str] = {}
        for line in raw_environment.splitlines():
            if not line or line.startswith("#") or "=" not in line:
                raise ValueError
            name, value = line.split("=", 1)
            if name in values or name not in expected_names or not value:
                raise ValueError
            values[name] = value
        if set(values) != expected_names:
            raise ValueError
        if (
            values["NODE_ENV"] != "production"
            or values["REFUNDDESK_RETENTION_SCOPE"] != "test_sandbox"
            or not values["REFUNDDESK_RETENTION_BATCH_SIZE"].isdigit()
            or not 1 <= int(values["REFUNDDESK_RETENTION_BATCH_SIZE"]) <= 100
            or len(
                base64.b64decode(
                    values["REFUNDDESK_PURGE_PSEUDONYM_HMAC_KEY_V1"],
                    validate=True,
                )
            )
            != 32
        ):
            raise ValueError
        database_url = urllib.parse.urlsplit(
            values["REFUNDDESK_MAINTENANCE_DATABASE_URL"]
        )
        if not re.fullmatch(
            r"(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+",
            database_url.password or "",
        ):
            raise ValueError
        if (
            database_url.scheme not in {"postgres", "postgresql"}
            or urllib.parse.unquote(database_url.username or "")
            != "refunddesk_maintenance_login"
            or database_url.hostname != "postgres.refunddesk.internal"
            or database_url.port != 5432
            or database_url.path != "/refunddesk"
            or database_url.query != "sslmode=verify-full"
            or database_url.fragment
        ):
            raise ValueError
        password_lines = raw_password.splitlines()
        if (
            len(password_lines) != 1
            or len(password_lines[0]) < 32
            or urllib.parse.unquote(database_url.password or "") != password_lines[0]
        ):
            raise ValueError
    except (OSError, UnicodeError, ValueError, binascii.Error) as error:
        raise ContractError("maintenance environment binding is invalid") from error


def validate_backup(environment_path: Path, aws_config_path: Path) -> None:
    expected_names = {
        "AWS_CONFIG_FILE",
        "AWS_DEFAULT_REGION",
        "AWS_REGION",
        "REFUNDDESK_BACKUP_AGE_RECIPIENT",
        "REFUNDDESK_BACKUP_BUCKET",
        "REFUNDDESK_BACKUP_PREFIX",
        "REFUNDDESK_BACKUP_RETENTION_COUNT",
    }
    assert_root_control_path(environment_path, secret=True)
    assert_root_control_path(aws_config_path, secret=True)
    try:
        raw_environment = environment_path.read_text(encoding="utf-8")
        raw_aws_config = aws_config_path.read_text(encoding="utf-8")
        if "\r" in raw_environment or "\r" in raw_aws_config:
            raise ValueError
        values: dict[str, str] = {}
        for line in raw_environment.splitlines():
            if not line or line.startswith("#") or "=" not in line:
                raise ValueError
            name, value = line.split("=", 1)
            if name in values or name not in expected_names or not value:
                raise ValueError
            values[name] = value
        if set(values) != expected_names:
            raise ValueError
        if (
            values["AWS_CONFIG_FILE"] != str(aws_config_path)
            or values["AWS_REGION"] != values["AWS_DEFAULT_REGION"]
            or re.fullmatch(
                r"[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*", values["AWS_REGION"]
            )
            is None
            or BUCKET.fullmatch(values["REFUNDDESK_BACKUP_BUCKET"]) is None
            or re.fullmatch(
                r"age1[0-9a-z]+", values["REFUNDDESK_BACKUP_AGE_RECIPIENT"]
            )
            is None
            or re.fullmatch(
                r"refunddesk-sandbox/[A-Za-z0-9._/-]*/",
                values["REFUNDDESK_BACKUP_PREFIX"],
            )
            is None
            or ".." in values["REFUNDDESK_BACKUP_PREFIX"]
            or re.fullmatch(
                r"[1-9][0-9]?", values["REFUNDDESK_BACKUP_RETENTION_COUNT"]
            )
            is None
            or re.search(
                r"(?im)(^|\s)aws_(?:access_key_id|secret_access_key)\s*=",
                raw_aws_config,
            )
            is not None
        ):
            raise ValueError
    except (OSError, UnicodeError, ValueError) as error:
        raise ContractError("backup environment binding is invalid") from error


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def validate_quiesce_journal(value: Any) -> dict[str, Any]:
    journal = require_keys(
        value, {"operation", "revision", "schemaVersion", "status"}, "quiesce journal"
    )
    if (
        journal["schemaVersion"] != 1
        or journal["status"] != "in_progress"
        or journal["operation"] not in QUIESCE_OPERATIONS
        or not isinstance(journal["revision"], str)
        or REVISION.fullmatch(journal["revision"]) is None
    ):
        raise ContractError("quiesce journal is invalid")
    return journal


def expected_quiesce(operation: str, revision: str) -> dict[str, Any]:
    return validate_quiesce_journal(
        {
            "operation": operation,
            "revision": revision,
            "schemaVersion": 1,
            "status": "in_progress",
        }
    )


def prepare_quiesce(journal_path: Path, operation: str, revision: str) -> None:
    candidate = expected_quiesce(operation, revision)
    payload = canonical_bytes(candidate)
    assert_root_control_directory(journal_path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(journal_path, flags, 0o600)
    except FileExistsError as error:
        assert_secure_journal(journal_path)
        validate_quiesce_journal(load_json(journal_path))
        raise ContractError("an unfinished runtime quiescence already exists") from error
    except OSError as error:
        raise ContractError("quiesce journal cannot be created") from error

    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(journal_path, 0o600)
        fsync_regular_file(journal_path)
        fsync_directory(journal_path.parent)
    except BaseException:
        try:
            journal_path.unlink()
            fsync_directory(journal_path.parent)
        except OSError:
            pass
        raise


def assert_quiesce(journal_path: Path, operation: str, revision: str) -> None:
    expected = expected_quiesce(operation, revision)
    assert_secure_journal(journal_path)
    existing = validate_quiesce_journal(load_json(journal_path))
    if canonical_bytes(existing) != canonical_bytes(expected):
        raise ContractError("quiesce journal differs from the exact recovery request")


def clear_quiesce(journal_path: Path, operation: str, revision: str) -> None:
    assert_quiesce(journal_path, operation, revision)
    durable_unlink(journal_path)


def validate_backup_upload_journal(value: Any) -> dict[str, Any]:
    journal = require_keys(
        value,
        {
            "archivePath",
            "bucket",
            "bytes",
            "objectKey",
            "revision",
            "schemaVersion",
            "sha256",
            "status",
        },
        "backup upload journal",
    )
    revision = journal["revision"]
    archive_path = journal["archivePath"]
    object_key = journal["objectKey"]
    if (
        journal["schemaVersion"] != 1
        or journal["status"] != "upload_pending"
        or not isinstance(revision, str)
        or REVISION.fullmatch(revision) is None
        or not isinstance(archive_path, str)
        or not archive_path.startswith("/")
        or "\x00" in archive_path
        or Path(archive_path).parent != Path("/var/lib/refunddesk/backups")
        or not isinstance(object_key, str)
        or not re.fullmatch(r"refunddesk-sandbox/[A-Za-z0-9._/-]+", object_key)
        or ".." in object_key
        or not isinstance(journal["bucket"], str)
        or BUCKET.fullmatch(journal["bucket"]) is None
        or not isinstance(journal["bytes"], int)
        or isinstance(journal["bytes"], bool)
        or journal["bytes"] <= 0
        or not isinstance(journal["sha256"], str)
        or SHA256.fullmatch(journal["sha256"]) is None
    ):
        raise ContractError("backup upload journal is invalid")
    archive_name = Path(archive_path).name
    if (
        re.fullmatch(
            rf"postgres-[0-9]{{8}}T[0-9]{{6}}Z-{re.escape(revision)}"
            r"\.tar\.zst\.age",
            archive_name,
        )
        is None
        or not object_key.endswith(f"/{archive_name}")
    ):
        raise ContractError("backup upload journal archive binding is invalid")
    return journal


def expected_backup_upload(
    archive_path: str,
    bucket: str,
    byte_count: int,
    object_key: str,
    revision: str,
    sha256: str,
) -> dict[str, Any]:
    return validate_backup_upload_journal(
        {
            "archivePath": archive_path,
            "bucket": bucket,
            "bytes": byte_count,
            "objectKey": object_key,
            "revision": revision,
            "schemaVersion": 1,
            "sha256": sha256,
            "status": "upload_pending",
        }
    )


def prepare_backup_upload(
    journal_path: Path,
    archive_path: str,
    bucket: str,
    byte_count: int,
    object_key: str,
    revision: str,
    sha256: str,
) -> None:
    candidate = expected_backup_upload(
        archive_path, bucket, byte_count, object_key, revision, sha256
    )
    payload = canonical_bytes(candidate)
    assert_root_control_directory(journal_path.parent)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(journal_path, flags, 0o600)
    except FileExistsError as error:
        assert_secure_journal(journal_path)
        validate_backup_upload_journal(load_json(journal_path))
        raise ContractError("an unfinished backup upload already exists") from error
    except OSError as error:
        raise ContractError("backup upload journal cannot be created") from error
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(journal_path, 0o600)
        fsync_regular_file(journal_path)
        fsync_directory(journal_path.parent)
    except BaseException:
        try:
            journal_path.unlink()
            fsync_directory(journal_path.parent)
        except OSError:
            pass
        raise


def assert_backup_upload(
    journal_path: Path,
    archive_path: str,
    bucket: str,
    byte_count: int,
    object_key: str,
    revision: str,
    sha256: str,
) -> None:
    expected = expected_backup_upload(
        archive_path, bucket, byte_count, object_key, revision, sha256
    )
    assert_secure_journal(journal_path)
    existing = validate_backup_upload_journal(load_json(journal_path))
    if canonical_bytes(existing) != canonical_bytes(expected):
        raise ContractError("backup upload journal differs from the exact artifact")


def clear_backup_upload(
    journal_path: Path,
    archive_path: str,
    bucket: str,
    byte_count: int,
    object_key: str,
    revision: str,
    sha256: str,
) -> None:
    assert_backup_upload(
        journal_path,
        archive_path,
        bucket,
        byte_count,
        object_key,
        revision,
        sha256,
    )
    durable_unlink(journal_path)


def prepare(journal_path: Path, candidate_path: Path) -> str:
    candidate = validate_journal(load_json(candidate_path))
    payload = canonical_bytes(candidate)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(journal_path, flags, 0o600)
    except FileExistsError:
        assert_secure_journal(journal_path)
        existing = validate_journal(load_json(journal_path))
        if canonical_bytes(existing) != payload:
            raise ContractError("unfinished transition differs from the requested release")
        return "resumed"
    except OSError as error:
        raise ContractError("transition journal cannot be created") from error

    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(journal_path, 0o600)
        fsync_directory(journal_path.parent)
    except BaseException:
        try:
            journal_path.unlink()
        except OSError:
            pass
        raise
    return "created"


def validate_commit_marker(value: Any) -> dict[str, Any]:
    marker = require_keys(
        value, {"from", "schemaVersion", "status", "to"}, "commit marker"
    )
    if marker["schemaVersion"] != 1 or marker["status"] != "committed":
        raise ContractError("commit marker version or status is invalid")
    candidate = dict(marker)
    candidate["status"] = "in_progress"
    validate_journal(candidate)
    return marker


def write_commit_marker(marker_path: Path, candidate: dict[str, Any]) -> None:
    marker = dict(candidate)
    marker["status"] = "committed"
    temporary_name = ""
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{marker_path.name}.", dir=marker_path.parent
        )
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(canonical_bytes(marker))
            stream.flush()
            os.fsync(stream.fileno())
        durable_replace(Path(temporary_name), marker_path, 0o600)
        temporary_name = ""
    except OSError as error:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
        raise ContractError("durable transition commit marker failed") from error


def complete(journal_path: Path, candidate_path: Path, marker_path: Path) -> None:
    candidate = validate_journal(load_json(candidate_path))
    assert_secure_journal(journal_path)
    existing = validate_journal(load_json(journal_path))
    if canonical_bytes(existing) != canonical_bytes(candidate):
        raise ContractError("transition journal changed before commit")
    write_commit_marker(marker_path, candidate)
    journal_path.unlink()
    fsync_directory(journal_path.parent)


def assert_commit(marker_path: Path, candidate_path: Path) -> None:
    candidate = validate_journal(load_json(candidate_path))
    assert_secure_journal(marker_path)
    marker = validate_commit_marker(load_json(marker_path))
    expected = dict(candidate)
    expected["status"] = "committed"
    if canonical_bytes(marker) != canonical_bytes(expected):
        raise ContractError("transition commit marker differs from the exact candidate")


def parse_environment(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ContractError("environment file is unreadable") from error
    for line in lines:
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ContractError("environment file contains a malformed line")
        name, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name) or name in values:
            raise ContractError("environment file contains an invalid or duplicate name")
        values[name] = value
    return values


def fingerprint(value: str | None) -> str | None:
    if value is None:
        return None
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def fingerprint_environment(platform_path: Path, worker_path: Path) -> dict[str, Any]:
    platform = parse_environment(platform_path)
    worker = parse_environment(worker_path)
    sources = {
        "approvalAttestation": worker,
        "field": platform,
        "proof": worker,
    }
    result: dict[str, Any] = {}
    for family in FAMILIES:
        first, second = ENV_KEYS[family]
        for name in (first, second):
            value = sources[family].get(name)
            if value is not None and (
                value != value.strip() or value.startswith(("'", '"'))
            ):
                raise ContractError("application-key environment encoding is ambiguous")
        result[family] = {
            "v1": fingerprint(sources[family].get(first)),
            "v2": fingerprint(sources[family].get(second)),
        }
    return validate_fingerprints(result, "fingerprints")


def environment_array(value: Any) -> dict[str, str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractError("container environment is invalid")
    result: dict[str, str] = {}
    for item in value:
        if "=" not in item:
            continue
        name, entry = item.split("=", 1)
        if name in result:
            raise ContractError("container environment contains a duplicate name")
        result[name] = entry
    return result


def fingerprint_inspect(expected_revision: str) -> dict[str, Any]:
    try:
        inspected = json.load(sys.stdin)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError("container inspection is invalid") from error
    if (
        not isinstance(inspected, list)
        or len(inspected) != 2
        or REVISION.fullmatch(expected_revision) is None
    ):
        raise ContractError("container inspection has an invalid shape")

    environments: list[dict[str, str]] = []
    for container in inspected:
        if not isinstance(container, dict):
            raise ContractError("container inspection has an invalid entry")
        config = container.get("Config")
        if not isinstance(config, dict):
            raise ContractError("container.Config has an invalid shape")
        labels = config.get("Labels")
        if (
            not isinstance(labels, dict)
            or labels.get("org.opencontainers.image.revision") != expected_revision
        ):
            raise ContractError("active container revision label differs")
        environments.append(environment_array(config.get("Env")))

    sources = {
        "approvalAttestation": environments[1],
        "field": environments[0],
        "proof": environments[1],
    }
    result: dict[str, Any] = {}
    for family in FAMILIES:
        first, second = ENV_KEYS[family]
        result[family] = {
            "v1": fingerprint(sources[family].get(first)),
            "v2": fingerprint(sources[family].get(second)),
        }
    return validate_fingerprints(result, "fingerprints")


def assert_union(previous_path: Path, target_path: Path) -> None:
    previous = validate_fingerprints(load_json(previous_path), "previous")
    target = validate_fingerprints(load_json(target_path), "target")
    for family in FAMILIES:
        for version in VERSIONS:
            prior = previous[family][version]
            if prior is not None and target[family][version] != prior:
                raise ContractError("target key set does not preserve the prior key union")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=True)
    subcommands = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subcommands.add_parser("prepare")
    prepare_parser.add_argument("--path", required=True, type=Path)
    prepare_parser.add_argument("--candidate", required=True, type=Path)

    complete_parser = subcommands.add_parser("complete")
    complete_parser.add_argument("--path", required=True, type=Path)
    complete_parser.add_argument("--candidate", required=True, type=Path)
    complete_parser.add_argument("--commit-marker", required=True, type=Path)

    commit_parser = subcommands.add_parser("assert-commit")
    commit_parser.add_argument("--marker", required=True, type=Path)
    commit_parser.add_argument("--candidate", required=True, type=Path)

    environment_parser = subcommands.add_parser("fingerprint-env")
    environment_parser.add_argument("--platform", required=True, type=Path)
    environment_parser.add_argument("--worker", required=True, type=Path)

    inspect_parser = subcommands.add_parser("fingerprint-inspect")
    inspect_parser.add_argument("--expected-revision", required=True)

    union_parser = subcommands.add_parser("assert-union")
    union_parser.add_argument("--previous", required=True, type=Path)
    union_parser.add_argument("--target", required=True, type=Path)

    maintenance_parser = subcommands.add_parser("validate-maintenance")
    maintenance_parser.add_argument("--environment", required=True, type=Path)
    maintenance_parser.add_argument("--password", required=True, type=Path)

    backup_configuration_parser = subcommands.add_parser("validate-backup")
    backup_configuration_parser.add_argument(
        "--environment", required=True, type=Path
    )
    backup_configuration_parser.add_argument("--aws-config", required=True, type=Path)

    replace_parser = subcommands.add_parser("durable-replace")
    replace_parser.add_argument("--source", required=True, type=Path)
    replace_parser.add_argument("--target", required=True, type=Path)
    replace_parser.add_argument(
        "--mode", required=True, choices=("0600", "0644", "0755")
    )

    symlink_parser = subcommands.add_parser("durable-symlink")
    symlink_parser.add_argument("--target", required=True, type=Path)
    symlink_parser.add_argument("--value", required=True)

    unlink_parser = subcommands.add_parser("durable-unlink")
    unlink_parser.add_argument("--target", required=True, type=Path)

    paths_parser = subcommands.add_parser("fsync-paths")
    paths_parser.add_argument("--path", action="append", default=[], type=Path)
    paths_parser.add_argument("--directory", action="append", default=[], type=Path)

    tree_parser = subcommands.add_parser("fsync-tree")
    tree_parser.add_argument("--path", required=True, type=Path)

    directory_parser = subcommands.add_parser("fsync-directory")
    directory_parser.add_argument("--path", required=True, type=Path)

    prepare_quiesce_parser = subcommands.add_parser("prepare-quiesce")
    prepare_quiesce_parser.add_argument("--path", required=True, type=Path)
    prepare_quiesce_parser.add_argument(
        "--operation", required=True, choices=tuple(sorted(QUIESCE_OPERATIONS))
    )
    prepare_quiesce_parser.add_argument("--revision", required=True)

    assert_quiesce_parser = subcommands.add_parser("assert-quiesce")
    assert_quiesce_parser.add_argument("--path", required=True, type=Path)
    assert_quiesce_parser.add_argument(
        "--operation", required=True, choices=tuple(sorted(QUIESCE_OPERATIONS))
    )
    assert_quiesce_parser.add_argument("--revision", required=True)

    clear_quiesce_parser = subcommands.add_parser("clear-quiesce")
    clear_quiesce_parser.add_argument("--path", required=True, type=Path)
    clear_quiesce_parser.add_argument(
        "--operation", required=True, choices=tuple(sorted(QUIESCE_OPERATIONS))
    )
    clear_quiesce_parser.add_argument("--revision", required=True)

    for backup_command in (
        "prepare-backup-upload",
        "assert-backup-upload",
        "clear-backup-upload",
    ):
        backup_parser = subcommands.add_parser(backup_command)
        backup_parser.add_argument("--path", required=True, type=Path)
        backup_parser.add_argument("--archive", required=True)
        backup_parser.add_argument("--bucket", required=True)
        backup_parser.add_argument("--bytes", required=True, type=int)
        backup_parser.add_argument("--object-key", required=True)
        backup_parser.add_argument("--revision", required=True)
        backup_parser.add_argument("--sha256", required=True)
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        if arguments.command == "prepare":
            status = prepare(arguments.path, arguments.candidate)
            print(json.dumps({"component": "release-transition", "status": status}))
        elif arguments.command == "complete":
            complete(arguments.path, arguments.candidate, arguments.commit_marker)
            print(json.dumps({"component": "release-transition", "status": "committed"}))
        elif arguments.command == "assert-commit":
            assert_commit(arguments.marker, arguments.candidate)
            print(json.dumps({"component": "release-transition", "status": "committed"}))
        elif arguments.command == "fingerprint-env":
            print(
                json.dumps(
                    fingerprint_environment(arguments.platform, arguments.worker),
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
        elif arguments.command == "fingerprint-inspect":
            print(
                json.dumps(
                    fingerprint_inspect(arguments.expected_revision),
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
        elif arguments.command == "assert-union":
            assert_union(arguments.previous, arguments.target)
            print(json.dumps({"component": "release-transition", "status": "union"}))
        elif arguments.command == "validate-maintenance":
            validate_maintenance(arguments.environment, arguments.password)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "maintenance-valid"}
                )
            )
        elif arguments.command == "validate-backup":
            validate_backup(arguments.environment, arguments.aws_config)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "backup-valid"}
                )
            )
        elif arguments.command == "durable-replace":
            durable_replace(
                arguments.source,
                arguments.target,
                int(arguments.mode, 8),
            )
            print(
                json.dumps(
                    {"component": "release-transition", "status": "durable-replace"}
                )
            )
        elif arguments.command == "durable-symlink":
            durable_symlink(arguments.target, arguments.value)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "durable-symlink"}
                )
            )
        elif arguments.command == "durable-unlink":
            durable_unlink(arguments.target)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "durable-unlink"}
                )
            )
        elif arguments.command == "fsync-paths":
            fsync_paths(arguments.path, arguments.directory)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "paths-synced"}
                )
            )
        elif arguments.command == "fsync-tree":
            fsync_tree(arguments.path)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "tree-synced"}
                )
            )
        elif arguments.command == "fsync-directory":
            assert_root_control_directory(arguments.path)
            fsync_directory(arguments.path)
            print(
                json.dumps(
                    {"component": "release-transition", "status": "directory-synced"}
                )
            )
        elif arguments.command == "prepare-quiesce":
            prepare_quiesce(arguments.path, arguments.operation, arguments.revision)
            print(
                json.dumps(
                    {
                        "component": "runtime-quiesce",
                        "operation": arguments.operation,
                        "status": "prepared",
                    }
                )
            )
        elif arguments.command == "assert-quiesce":
            assert_quiesce(arguments.path, arguments.operation, arguments.revision)
            print(
                json.dumps(
                    {
                        "component": "runtime-quiesce",
                        "operation": arguments.operation,
                        "status": "in_progress",
                    }
                )
            )
        elif arguments.command == "clear-quiesce":
            clear_quiesce(arguments.path, arguments.operation, arguments.revision)
            print(
                json.dumps(
                    {
                        "component": "runtime-quiesce",
                        "operation": arguments.operation,
                        "status": "recovered",
                    }
                )
            )
        elif arguments.command in {
            "prepare-backup-upload",
            "assert-backup-upload",
            "clear-backup-upload",
        }:
            backup_arguments = (
                arguments.path,
                arguments.archive,
                arguments.bucket,
                arguments.bytes,
                arguments.object_key,
                arguments.revision,
                arguments.sha256,
            )
            if arguments.command == "prepare-backup-upload":
                prepare_backup_upload(*backup_arguments)
                backup_status = "prepared"
            elif arguments.command == "assert-backup-upload":
                assert_backup_upload(*backup_arguments)
                backup_status = "upload_pending"
            else:
                clear_backup_upload(*backup_arguments)
                backup_status = "reconciled"
            print(
                json.dumps(
                    {
                        "component": "backup-upload",
                        "status": backup_status,
                    }
                )
            )
        else:
            raise ContractError("unknown command")
        return 0
    except ContractError:
        print(
            json.dumps(
                {
                    "code": "RELEASE_TRANSITION_CONTRACT_INVALID",
                    "component": "release-transition",
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
