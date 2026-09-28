"""운영자 알림 (텔레그램 봇).

앱을 처음 켠 기기, PLAY 시작, PLAY CLEAR 를 운영자 폰으로 바로 알린다.
TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 없으면 아무것도 하지 않는다 (로컬·테스트).

⚠️ 텔레그램 서버(해외)에 메시지가 남는다. 이 앱은 계정도 기기 식별자도 없으니
   싣는 것은 「어느 앱에서 · 무슨 일이 · 어느 PLAY 에서」뿐이다.
   더 싣고 싶으면 개인정보처리방침 §4 부터 고쳐야 한다.

알림은 부가 기능이라 어떤 경우에도 예외를 던지지 않는다.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque

import requests

logger = logging.getLogger(__name__)

SEND_TIMEOUT_SEC = 5

# 한 시간에 보내는 알림 상한. `POST /event` 는 인증이 없어서 누가 스크립트로 두드리면
# 운영자 폰이 알림으로 뒤덮인다. 넘친 알림은 버리고, 다음에 보내는 알림에 몇 건 버렸는지 적는다.
HOURLY_CAP = 60
_sent_at: deque[float] = deque()
_dropped = 0
_lock = threading.Lock()


def send_admin_message(text: str) -> bool:
    """텔레그램으로 한 통 보낸다. 보냈으면 True. 절대 예외를 던지지 않는다."""
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return False

    try:
        res = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
            timeout=SEND_TIMEOUT_SEC,
        )
    except Exception as e:  # noqa: BLE001 — 알림 실패가 요청을 깨면 안 된다
        # 예외 메시지에 URL(=토큰)이 들어갈 수 있어 종류만 남긴다
        logger.warning("[AdminNotify] 텔레그램 발송 오류 (서비스에는 영향 없음): %s", type(e).__name__)
        return False

    if not res.ok:
        logger.warning("[AdminNotify] 텔레그램 발송 실패: %s %s", res.status_code, res.text[:200])
        return False
    return True


def send_capped(text: str, now: float | None = None) -> bool:
    """한 시간 상한(HOURLY_CAP)을 지키며 보낸다. 넘치면 보내지 않고 센다."""
    global _dropped
    now = time.time() if now is None else now
    with _lock:
        while _sent_at and now - _sent_at[0] >= 3600:
            _sent_at.popleft()
        if len(_sent_at) >= HOURLY_CAP:
            _dropped += 1
            return False
        _sent_at.append(now)
        dropped, _dropped = _dropped, 0
    if dropped:
        text = f"{text}\n(한 시간 상한을 넘어 알림 {dropped}건을 건너뛰었어요)"
    return send_admin_message(text)
