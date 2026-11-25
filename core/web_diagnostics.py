"""Shared read-only diagnostics: persisted stage timings, storage/WAL health and config preflight."""
import os
from pathlib import Path
import shutil
import time


_WAL_WARN_BYTES = 32 * 1024 * 1024
_WAL_CRIT_BYTES = 128 * 1024 * 1024
_LOG_USAGE_CACHE: dict[str, tuple[float, int, int]] = {}


def _scan_dir_usage(root: Path, *, max_files: int = 4000) -> tuple[int, int]:
    """带 30 秒缓存的目录占用统计，避免 5 秒轮询反复遍历大量日志文件。"""
    key = str(root)
    now = time.monotonic()
    cached = _LOG_USAGE_CACHE.get(key)
    if cached is not None and now - cached[0] < 30.0:
        return cached[1], cached[2]
    count = 0
    total = 0
    if root.is_dir():
        for dirpath, _dirs, filenames in os.walk(root):
            for name in filenames:
                count += 1
                try:
                    total += os.stat(os.path.join(dirpath, name)).st_size
                except OSError:
                    pass
                if count >= max_files:
                    break
            if count >= max_files:
                break
    _LOG_USAGE_CACHE[key] = (now, count, total)
    return count, total


def storage_health(store) -> dict:
    """采集 SQLite 主库、WAL/SHM 体积、日志目录占用及所在磁盘剩余空间。"""
    db_path = Path(store.db_path)
    wal_path = Path(str(db_path) + "-wal")
    shm_path = Path(str(db_path) + "-shm")
    db_bytes = db_path.stat().st_size if db_path.is_file() else 0
    wal_bytes = wal_path.stat().st_size if wal_path.is_file() else 0
    shm_bytes = shm_path.stat().st_size if shm_path.is_file() else 0
    wal_state = "critical" if wal_bytes >= _WAL_CRIT_BYTES else ("warn" if wal_bytes >= _WAL_WARN_BYTES else "ok")

    log_dir = db_path.parent / "logs"
    log_files, log_bytes = _scan_dir_usage(log_dir)
    disk_free = disk_total = 0
    try:
        usage = shutil.disk_usage(db_path.parent if db_path.parent.exists() else Path.cwd())
        disk_free = int(usage.free)
        disk_total = int(usage.total)
    except OSError:
        pass
    return {
        "db_bytes": db_bytes,
        "wal_bytes": wal_bytes,
        "shm_bytes": shm_bytes,
        "wal_state": wal_state,
        "wal_warn_bytes": _WAL_WARN_BYTES,
        "log_files": log_files,
        "log_bytes": log_bytes,
        "disk_free_bytes": disk_free,
        "disk_total_bytes": disk_total,
    }


def handle_diagnostics(handler, parts, query, method, store, component):
    from core.web_ux_api import handle_ux_api
    if handle_ux_api(handler, parts, query, method, store, component) is not False:
        return
    from scdfe_c.web.service import ApiError
    allowed = (['diagnostics'],['api','diagnostics'],['static','diagnostics.css'],['static','diagnostics.js'])
    if parts not in allowed:
        return False
    if method != 'GET':
        raise ApiError(405,'运行诊断只支持 GET 查询')
    assets=Path(__file__).with_name('web_static')
    from core.web_http import send_static
    if parts[0]=='static':
        mime='text/css' if parts[1].endswith('.css') else 'application/javascript'
        return send_static(handler,assets/parts[1],mime+'; charset=utf-8')
    if parts==['diagnostics']:
        if component in ('s','c','t'):
            from core.web_workbench import render_workbench
            return send_static(
                handler,
                assets/'diagnostics.html',
                'text/html; charset=utf-8',
                transform=lambda raw: render_workbench(raw,component,'diagnostics.html'),
                cache_key=f'workbench:{component}:diagnostics.html',
            )
        return send_static(handler,assets/'diagnostics.html','text/html; charset=utf-8')
    if set(query)-{'checks'} or query.get('checks','0') not in ('0','1'):
        raise ApiError(400,'checks 只能为 0 或 1')
    services=None
    if component=='s':
        services=handler._channel_service_map()
        running={key:service for key,service in services.items() if service.running}
        handler._monitor_statuses(running,{})
    from core.runtime_status import runtime_status_rows
    prefix='scdfe_'+component
    now=int(time.time()*1000)
    rows=[]
    # 按 service_name 走主键前缀索引查询，避免全表扫描无关组件的运行态 JSON。
    status_rows = runtime_status_rows(store, service_name=prefix) + runtime_status_rows(store, service_name=prefix + '_writer')
    for row in status_rows:
        timing=row['diagnostic'].get('latency',{})
        command_write=row['diagnostic'].get('command_write') or {}
        timing={**timing,**{'command_'+key:value for key,value in command_write.get('latency',{}).items()}}
        requests=row['diagnostic'].get('modbus_requests') or (row['diagnostic'].get('engine') or {}).get('modbus_requests')
        point_runtime=row['diagnostic'].get('point_runtime')
        if timing or requests or point_runtime:
            rows.append(dict(service=row['service_name'],channel_id=row['channel_id'],
                name=row['channel_name'],running=row['running'],sampled_at=row['sampled_at'],
                stale=now-row['sampled_at']>20000,latency=timing,
                source_delta=row['diagnostic'].get('source_delta',{}),
                soe_progress=row['diagnostic'].get('soe_progress'),
                database_wait=row['diagnostic'].get('database_wait'),
                slow_batches=row['diagnostic'].get('slow_batches'),
                command_write=row['diagnostic'].get('command_write'),
                modbus_requests=requests,
                point_runtime=point_runtime,
                pending_messages=row['diagnostic'].get('pending_messages')))
    payload=dict(component=component,items=rows,window=256,
        storage=storage_health(store),
        note='分位数来自最近 256 个阶段样本，不可相加作为端到端时延；完整链路需用同一变化的关联验收记录。')
    if query.get('checks')=='1':
        from core.startup_checks import configuration_checks
        payload['checks']=configuration_checks(store,component,services)
        payload['checked_at']=now
    return handler._json(200,payload)
