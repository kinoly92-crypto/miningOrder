#!/usr/bin/env python3
"""Create the root-only systemd environment file for the mining-order application."""

import getpass
import os
import secrets
import sys
import warnings


CONFIG_DIR = "/etc/mining-order"
CONFIG_FILE = os.path.join(CONFIG_DIR, "app.env")


def systemd_value(value):
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Input must not contain control characters.")
    for char in ("\\", '"', "$", "`"):
        value = value.replace(char, "\\" + char)
    return f'"{value}"'


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run this tool as root.")
    if os.path.lexists(CONFIG_DIR):
        raise RuntimeError("Configuration directory already exists; refusing to overwrite it.")

    username = input("MySQL username: ").strip()
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        password = getpass.getpass("MySQL password (hidden): ")
    if not username or not password:
        raise ValueError("MySQL username and password must not be empty.")

    values = {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_DATABASE": "miningorder",
        "MYSQL_TLS": "false",
        "MYSQL_USER": username,
        "MYSQL_PASSWORD": password,
        "JWT_SECRET": secrets.token_hex(48),
    }
    contents = "".join(f"{name}={systemd_value(value)}\n" for name, value in values.items())

    os.mkdir(CONFIG_DIR, 0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(CONFIG_FILE, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as config:
        config.write(contents)
    print("Configuration created with owner-only permissions. Service has not been started.")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print("\nConfiguration cancelled.", file=sys.stderr)
        sys.exit(1)
    except (OSError, RuntimeError, ValueError, getpass.GetPassWarning) as error:
        print(f"Configuration failed: {error}", file=sys.stderr)
        sys.exit(1)
