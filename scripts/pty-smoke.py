#!/usr/bin/env python3
"""Isolated PTY smoke harness for the built selora chat CLI.

The script intentionally does not claim success for scenarios the current CLI
cannot exercise. It launches only the supplied local bundle, a local mock HTTP
server, and a throwaway HOME/XDG/project.
"""
import argparse
import http.server
import json
import os
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time
import tty
import urllib.parse
import uuid


class Gateway(http.server.BaseHTTPRequestHandler):
    requests = []
    mode = "plain"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path.startswith('/v1/models/'):
            body = json.dumps({"model": {"id": "glm-5.3-flash", "display_name": "Flash", "provider": "mock", "status": "active"}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode())
        except Exception:
            payload = None
        Gateway.requests.append(payload)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        text = "fast" if Gateway.mode == "fast" else "hello"
        chunks = ["data: " + json.dumps({"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}) + "\n\n", "data: " + json.dumps({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}) + "\n\n", "data: [DONE]\n\n"]
        for chunk in chunks:
            self.wfile.write(chunk.encode())
            self.wfile.flush()


def read_until(fd, needle, timeout=5.0):
    data = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        wait = max(0.01, deadline - time.monotonic())
        ready, _, _ = select.select([fd], [], [], wait)
        if not ready:
            continue
        try:
            part = os.read(fd, 4096)
        except OSError:
            break
        if not part:
            break
        data.extend(part)
        if needle in data:
            return bytes(data)
    return bytes(data)


def write_fragmented(fd, text):
    raw = text.encode()
    for i in range(0, len(raw), 3):
        os.write(fd, raw[i : i + 3])
        time.sleep(0.01)


def resize(fd, columns, rows):
    winsize = struct.pack("HHHH", rows, columns, 0, 0)
    termios_ioctl = getattr(termios, "TIOCSWINSZ")
    import fcntl
    fcntl.ioctl(fd, termios_ioctl, winsize)


def scenario(cli, mode):
    Gateway.mode = mode
    Gateway.requests = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = tempfile.mkdtemp(prefix="selora-pty-")
    home = os.path.join(root, "home")
    project = os.path.join(root, "project")
    os.makedirs(home)
    os.makedirs(project)
    env = os.environ.copy()
    env.update({"HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"), "SELORA_API_URL": f"http://127.0.0.1:{server.server_port}", "SELORA_API_KEY": "sk-gw-TEST", "NO_COLOR": "1"})
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(project)
        os.execvpe(cli[0], cli + ["chat", "--model", "glm-5.3-flash"], env)
    try:
        tty.setraw(master)
        resize(master, 80, 24)
        startup = read_until(master, b"Connected", 12)
        if b"Connected" not in startup:
            raise AssertionError("startup/model verification not observed")
        write_fragmented(master, "hello\r")
        response = read_until(master, b"hello", 8)
        if b"hello" not in response:
            raise AssertionError("plain response not observed")
        write_fragmented(master, "paste\nline\r")
        read_until(master, b"hello", 8)
        os.write(master, b"\x04")
        read_until(master, b"", 2)
        if not Gateway.requests:
            raise AssertionError("mock gateway received no request")
        compact = bytes(startup + response).replace(b"\x1b", b"<ESC>")[-800:]
        print(json.dumps({"scenario": mode, "requests": len(Gateway.requests), "evidence": compact.decode("utf-8", "replace")}))
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except Exception:
            pass
        server.shutdown()
        server.server_close()
        shutil.rmtree(root, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", required=True, help="absolute path to node executable")
    parser.add_argument("--node", default="node", help="node executable")
    parser.add_argument("--scenario", choices=["plain", "fast"], default="plain")
    args = parser.parse_args()
    scenario([args.node, args.cli], args.scenario)


if __name__ == "__main__":
    main()
