"""앱에서 일어난 일 — 운영자 텔레그램 알림용.

## 왜 있나

놀멍봅서에는 회원가입이 없다. 그래서 「누가 새로 들어왔나」「실제로 PLAY 를 하나」를
알 길이 없었다. 앱이 세 순간만 서버에 알려 주고, 서버는 그걸 운영자 텔레그램으로 넘긴다.

    first_open   이 기기에서 앱을 처음 켰다 (가입 알림 자리)
    play_start   PLAY 를 처음부터 시작했다 (「이어서 하기」는 세지 않는다)
    play_clear   PLAY 를 CLEAR 했다

## ⚠️ 사용자를 식별하는 값을 받지 않는다

기기 ID·위치·이름 없음. 받는 것은 어느 앱(iOS/토스)인지, 어느 PLAY 인지,
CLEAR 때 걸린 분·건너뛴 미션 수뿐이다. 처리방침 §4 가 그렇게 약속한다 —
여기에 무엇을 더하려면 **처리방침부터 고쳐야 한다.**

저장하지 않는다. 텔레그램으로 넘기고 끝이다.
"""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from services import play_loader
from services.admin_notify import send_capped
from services.db import get_db_connection

router = APIRouter(prefix="/event", tags=["event"])
limiter = Limiter(key_func=get_remote_address)
logger = logging.getLogger(__name__)

PLATFORM_LABEL = {"ios": "앱스토어", "toss": "토스"}


class AppEvent(BaseModel):
    type: Literal["first_open", "play_start", "play_clear"]
    platform: Literal["ios", "toss"]
    play_id: str = ""
    # CLEAR 때만. 이상한 값이어도 막지 않는다 — 앱은 실패한 알림을 다시 보내지 않아서,
    # 막으면 그 CLEAR 알림이 통째로 사라진다. 이어서 한 판은 며칠이 걸릴 수 있고
    # 기기 시계를 돌리면 음수도 온다. 보여줄 때 다듬는다.
    minutes: int | None = None
    skipped: int | None = Field(default=None, ge=0, le=100)


def format_event(body: AppEvent, play_title: str | None) -> str:
    where = PLATFORM_LABEL[body.platform]
    if body.type == "first_open":
        return f"📲 새 기기에서 처음 실행 · {where}"
    if body.type == "play_start":
        return f"▶️ PLAY 시작 · {where}\n{play_title}"

    detail = [play_title]
    if body.minutes is not None and body.minutes >= 24 * 60:
        detail.append("하루 이상 (이어서 한 판)")
    elif body.minutes is not None and body.minutes >= 0:
        detail.append(f"{body.minutes}분")
    if body.skipped:
        detail.append(f"건너뛴 미션 {body.skipped}")
    return f"🏆 CLEAR · {where}\n" + " · ".join(detail)


@router.post("", status_code=202)
@limiter.limit("30/minute")
def report_event(request: Request, body: AppEvent, background: BackgroundTasks) -> dict:
    play_title = None
    if body.type != "first_open":
        # 모르는 PLAY 는 막는다 — 아무 글자나 운영자 텔레그램에 흘려보내는 통로가 되면 안 된다.
        play = play_loader.get(get_db_connection(), body.play_id)
        if play is None:
            raise HTTPException(status_code=400, detail=f"모르는 PLAY: {body.play_id}")
        play_title = play.title

    text = format_event(body, play_title)
    logger.info("[EVENT] %s", text.replace("\n", " | "))
    # 텔레그램이 느려도 앱 응답은 기다리지 않는다
    background.add_task(send_capped, text)
    return {"ok": True}
