import subprocess
import os
import glob as glob_module
from config import ALLOW_SHELL


def run_shell(command: str, timeout: int = 30) -> dict:
    if not ALLOW_SHELL:
        return {"error": "Shell execution is disabled. Set ALLOW_SHELL=true to enable."}
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"error": f"Command timed out after {timeout}s", "exit_code": -1}
    except Exception as e:
        return {"error": str(e), "exit_code": -1}


def read_file(path: str) -> dict:
    path = os.path.expanduser(path)
    try:
        with open(path) as f:
            content = f.read()
        return {"content": content, "size": len(content), "path": path}
    except Exception as e:
        return {"error": str(e)}


def write_file(path: str, content: str) -> dict:
    path = os.path.expanduser(path)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(content)
        return {"success": True, "path": path, "bytes_written": len(content)}
    except Exception as e:
        return {"error": str(e)}


def list_directory(path: str) -> dict:
    path = os.path.expanduser(path)
    try:
        entries = []
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            entries.append({
                "name": name,
                "type": "dir" if os.path.isdir(full) else "file",
                "size": os.path.getsize(full) if os.path.isfile(full) else None,
            })
        return {"path": path, "entries": entries, "count": len(entries)}
    except Exception as e:
        return {"error": str(e)}


def search_files(pattern: str, directory: str = "~") -> dict:
    directory = os.path.expanduser(directory)
    try:
        matches = glob_module.glob(os.path.join(directory, "**", pattern), recursive=True)
        return {"matches": matches[:100], "count": len(matches)}
    except Exception as e:
        return {"error": str(e)}
