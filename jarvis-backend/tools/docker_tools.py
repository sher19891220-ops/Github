try:
    import docker as docker_sdk
    _client = docker_sdk.from_env()
    _available = True
except Exception:
    _client = None
    _available = False


def _check() -> dict | None:
    if not _available:
        return {"error": "Docker SDK not available or Docker not running"}
    return None


def docker_list() -> dict:
    if err := _check():
        return err
    try:
        containers = _client.containers.list(all=True)
        return {
            "containers": [
                {"id": c.short_id, "name": c.name, "status": c.status, "image": c.image.tags}
                for c in containers
            ],
            "count": len(containers),
        }
    except Exception as e:
        return {"error": str(e)}


def docker_exec(container_name: str, command: str) -> dict:
    if err := _check():
        return err
    try:
        container = _client.containers.get(container_name)
        exit_code, output = container.exec_run(command, demux=False)
        return {
            "container": container_name,
            "command": command,
            "output": output.decode() if output else "",
            "exit_code": exit_code,
        }
    except Exception as e:
        return {"error": str(e)}


def docker_logs(container_name: str, lines: int = 50) -> dict:
    if err := _check():
        return err
    try:
        container = _client.containers.get(container_name)
        logs = container.logs(tail=lines).decode()
        return {"container": container_name, "logs": logs, "lines": lines}
    except Exception as e:
        return {"error": str(e)}


def docker_start(container_name: str) -> dict:
    if err := _check():
        return err
    try:
        container = _client.containers.get(container_name)
        container.start()
        return {"success": True, "container": container_name, "action": "started"}
    except Exception as e:
        return {"error": str(e)}


def docker_stop(container_name: str) -> dict:
    if err := _check():
        return err
    try:
        container = _client.containers.get(container_name)
        container.stop()
        return {"success": True, "container": container_name, "action": "stopped"}
    except Exception as e:
        return {"error": str(e)}
