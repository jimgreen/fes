"""可选的 Web 访问权限守护（只读观察模式、运维口令会话、遥控二次确认）。

默认全部未配置，完全兼容既有本机零登录调试行为；仅当配置对应环境变量时激活。
环境变量：
  - SCADA_WEB_READONLY=1                  全局只读模式（拒绝一切写操作与进程/命令控制）
  - SCADA_WEB_OPERATOR_TOKEN=<secret>     运维解锁口令（未解锁时自动处于只读观察模式）
  - SCADA_WEB_COMMAND_CONFIRM_CODE=<code> 遥控/遥调下发二次确认口令（校验 X-Command-Confirm 请求头）
"""
from __future__ import annotations

import hashlib
import hmac
from http.cookies import SimpleCookie
import os
import secrets
import time


_SESSION_SECRET = secrets.token_bytes(32)
_COOKIE_NAME = "scada_op_session"
_SESSION_TTL = 12 * 3600

# 仅读取/计算的 POST 白名单路径（不修改任何数据库或进程状态）
_READONLY_POST_PATHS = frozenset({
    ("api", "packet-decode"),
    ("api", "auth", "session"),
})


def is_readonly_forced() -> bool:
    return os.environ.get("SCADA_WEB_READONLY", "").strip().lower() in ("1", "true", "yes", "on")


def operator_token() -> str:
    return os.environ.get("SCADA_WEB_OPERATOR_TOKEN", "").strip()


def command_confirm_code() -> str:
    return os.environ.get("SCADA_WEB_COMMAND_CONFIRM_CODE", "").strip()


def verify_operator_token(candidate: str) -> bool:
    expected = operator_token()
    if not expected:
        return True
    return hmac.compare_digest(str(candidate or "").strip(), expected)


def _sign_session(exp_ts: int) -> str:
    msg = f"{exp_ts}:{operator_token()}".encode("utf-8")
    sig = hmac.new(_SESSION_SECRET, msg, hashlib.sha256).hexdigest()[:32]
    return f"{exp_ts}.{sig}"


def create_session_cookie() -> str:
    exp_ts = int(time.time()) + _SESSION_TTL
    val = _sign_session(exp_ts)
    return f"{_COOKIE_NAME}={val}; Path=/; HttpOnly; SameSite=Strict; Max-Age={_SESSION_TTL}"


def clear_session_cookie() -> str:
    return f"{_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"


def _cookie_unlocked(handler) -> bool:
    raw = handler.headers.get("Cookie") if handler.headers else None
    if not raw:
        return False
    jar = SimpleCookie()
    try:
        jar.load(raw)
    except Exception:
        return False
    morsel = jar.get(_COOKIE_NAME)
    if not morsel or "." not in morsel.value:
        return False
    exp_str, sig = morsel.value.split(".", 1)
    if not exp_str.isdigit():
        return False
    exp_ts = int(exp_str)
    if exp_ts < int(time.time()):
        return False
    expected = _sign_session(exp_ts).split(".", 1)[1]
    return hmac.compare_digest(sig, expected)


def is_request_unlocked(handler) -> bool:
    if is_readonly_forced():
        return False
    expected = operator_token()
    if not expected:
        return True
    hdr_token = handler.headers.get("X-Scada-Token") if handler.headers else None
    if hdr_token and hmac.compare_digest(hdr_token.strip(), expected):
        return True
    return _cookie_unlocked(handler)


def auth_status(handler, *, unlocked_override: bool | None = None) -> dict:
    readonly = is_readonly_forced()
    token_required = bool(operator_token())
    unlocked = (
        False if readonly
        else (unlocked_override if unlocked_override is not None else is_request_unlocked(handler))
    )
    mode = "readonly" if readonly else ("protected" if token_required else "open")
    return {
        "mode": mode,
        "readonly": readonly,
        "token_required": token_required,
        "unlocked": unlocked,
        "command_confirm_required": bool(command_confirm_code()),
    }


def _is_command_path(parts: list[str]) -> bool:
    return len(parts) >= 4 and parts[0] == "api" and "commands" in parts


def enforce_web_access(handler, parts: list[str], method: str) -> None:
    """对所有写操作执行只读/运维口令校验，并对遥控/遥调执行可选二次确认校验。"""
    from scdfe_c.web.service import ApiError

    m = (method or "GET").upper()
    if m in ("GET", "HEAD", "OPTIONS"):
        return
    path_tuple = tuple(parts)
    if path_tuple in _READONLY_POST_PATHS:
        return
    # 支持 T 端 CSV 导入 dry_run 预检无需被写限制误杀？不，POST 接口统一受运维口令保护，确保安全边界清晰。
    if is_readonly_forced():
        raise ApiError(403, "当前服务处于只读观察模式（SCADA_WEB_READONLY=1），禁止写操作", code="readonly_mode")
    if operator_token() and not is_request_unlocked(handler):
        raise ApiError(401, "当前处于只读保护模式，请先解锁运维权限后再执行写操作", code="operator_auth_required")
    cmd_code = command_confirm_code()
    if cmd_code and _is_command_path(parts):
        supplied = (handler.headers.get("X-Command-Confirm") if handler.headers else "") or ""
        if not hmac.compare_digest(supplied.strip(), cmd_code):
            raise ApiError(403, "遥控/遥调下发需要提供有效的二次确认口令（X-Command-Confirm）", code="command_confirm_required")
