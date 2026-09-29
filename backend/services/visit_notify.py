"""앱이 서버를 부르는 모습을 보고 운영자 텔레그램으로 알린다.

## 왜 있나

공모전 심사위원이 언제 앱을 보는지 알고 싶다(2026-09-28). 심사는 이미 출시된
앱스토어 1.0 으로 하고, 그 앱에는 「알림용 신호」를 보내는 코드가 없다.
그래서 앱이 원래 부르는 요청을 서버가 보고 알린다 — 앱을 고치지 않아도 된다.

    조용하다가 첫 요청       👀 누군가 앱을 쓰기 시작했어요
    GET /place/detail       🏛️ 장소 상세 (한국관광공사 정보 화면)
    GET /plays/{id}         📜 PLAY 상세
    GET /tts/line           🎧 PLAY 시작 · 📍 지점 도착쯤 · 🏁 FINAL
    POST /course/list·detail 🧭 코스 추천
    GET /map/pins           🗺️ 지도 탭
    POST /report/mission    🚩 미션 신고

## 사람을 구분하지 않는다

IP 같은 값을 쓰지 않는다 — 처리방침을 고치지 않고 가기로 했다(2026-09-28).
대신 **앱 요청이 30분 넘게 없다가 다시 오면 새 방문**으로 본다. 한 방문 안에서
같은 일은 한 번만 알린다. 이용자가 적은 지금은 사실상 「누가 한 명 들어왔다」다.
두 사람이 동시에 쓰면 한 방문으로 섞인다.

## 정확하지 않은 곳

음성은 다음 대사를 미리 받아 둔다. 그래서 「지점 도착」「FINAL」은 실제보다
한 걸음 이르게 올 수 있다 — 문구에 「쯤」을 붙였다. 소리를 꺼 두면 음성 요청이
없어 PLAY 진행 알림도 없다(PLAY 상세 열람은 온다).

알림은 부가 기능이라 어떤 경우에도 예외를 던지지 않는다.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from urllib.parse import parse_qs

from services.admin_notify import send_capped

logger = logging.getLogger(__name__)

QUIET_GAP_SEC = 30 * 60

# Railway 가 넣어 주는 환경 이름 → 어느 앱의 서버인지. 모든 알림 맨 앞에 [앱스토어]/[토스] 로 붙는다
ENV_LABEL = {"production": "앱스토어", "apps-in-toss": "토스"}

# 앱이 부르는 주소. 이 밖의 요청(헬스체크·처리방침·봇의 아무 주소)은 방문으로 세지 않는다.
APP_PREFIXES = ("/plays", "/places/", "/place/", "/map/", "/tts/", "/course/", "/home/", "/report/")

_lock = threading.Lock()
_last_request_at: float | None = None
_notified: set[tuple] = set()  # 이번 방문에서 이미 알린 일
_play_cache: dict | None = None


def _play_info() -> dict:
    """{play_id: (제목, {point_id: (번호, 제목)})}. 원고는 배포할 때만 바뀌니 한 번 읽는다."""
    global _play_cache
    if _play_cache is None:
        from services import play_loader
        from services.db import get_db_connection
        _play_cache = {
            p.id: (p.title, {pt.id: (i, pt.title) for i, pt in enumerate(p.points, 1)})
            for p in play_loader.load_all(get_db_connection())
        }
    return _play_cache


def describe(method: str, path: str, query: str) -> tuple[tuple, str] | None:
    """요청 하나 → (이번 방문 안 중복 확인 열쇠, 알림 한 줄). 알릴 일이 아니면 None."""
    q = {k: v[0] for k, v in parse_qs(query).items()}

    if method == "GET" and path == "/place/detail":
        name = q.get("name", "")
        return ("place", name), f"🏛️ 장소 상세를 열었어요 · {name}"

    if method == "GET" and path.startswith("/plays/") and path.count("/") == 2:
        play_id = path.rsplit("/", 1)[1]
        info = _play_info().get(play_id)
        if info is None:
            return None
        return ("play_detail", play_id), f"📜 PLAY 상세를 열었어요 · {info[0]}"

    if method == "GET" and path == "/tts/line":
        play_id = q.get("play_id", "")
        info = _play_info().get(play_id)
        if info is None:
            return None
        title, points = info
        line = q.get("line", "")
        if line.startswith("point:") and line[6:] in points:
            n, name = points[line[6:]]
            if n > 1:  # 첫 지점 안내는 곧 PLAY 시작이다
                return ("point", play_id, n), f"📍 지점 {n}/{len(points)} 도착쯤 · {name}\n{title}"
        if line in ("final", "clear"):
            return ("final", play_id), f"🏁 FINAL 단계까지 왔어요 (CLEAR 직전)\n{title}"
        return ("play_start", play_id), f"🎧 PLAY를 시작했어요 · {title}"

    if method == "POST" and path in ("/course/list", "/course/detail"):
        return ("course",), "🧭 코스 추천을 보고 있어요"
    if method == "GET" and path == "/map/pins":
        return ("map",), "🗺️ 지도 탭을 열었어요"
    if method == "POST" and path == "/report/mission":
        # 신고는 건마다 알린다
        return ("report", time.time()), "🚩 미션 신고가 들어왔어요 (내용은 GET /report/mission)"
    return None


def observe(method: str, path: str, query: str, now: float | None = None) -> None:
    """응답을 돌려준 뒤 부른다. 알릴 게 있으면 보낸다. 절대 예외를 던지지 않는다."""
    global _last_request_at
    try:
        if not path.startswith(APP_PREFIXES):
            return
        now = time.time() if now is None else now
        where = ENV_LABEL.get(os.getenv("RAILWAY_ENVIRONMENT_NAME", ""), "로컬")
        event = describe(method, path, query)

        lines = []
        with _lock:
            if _last_request_at is None or now - _last_request_at >= QUIET_GAP_SEC:
                _notified.clear()
                lines.append("👀 누군가 앱을 쓰기 시작했어요")
            _last_request_at = now
            if event and event[0] not in _notified:
                _notified.add(event[0])
                lines.append(event[1])
        if lines:
            # 두 서버가 같은 봇으로 보낸다 — 어느 앱인지 모든 알림 맨 앞에 붙인다 (2026-09-29)
            send_capped(f"[{where}] " + "\n".join(lines))
    except Exception:  # noqa: BLE001 — 알림 때문에 서버가 깨지면 안 된다
        logger.exception("[VisitNotify] 알림을 만들지 못했습니다 (서비스에는 영향 없음)")
