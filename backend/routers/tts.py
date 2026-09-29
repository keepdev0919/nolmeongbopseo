"""TTS — 이야기를 곱닥이 목소리로 들려준다.

## 지금 쓰는 것: `/tts/story`

    발견 → Story 화면 → GET /tts/story?play_id=&story_id=
                        서버가 PLAY 원고에서 script 를 꺼내 읽어 준다
                        대본 해시로 캐시를 찾아 두 번째부터는 Typecast 0회

**Story 는 놀멍봅서가 직접 쓴 문장이다** (2026-09-02 결정). 오디 대본을 그대로
재생하지 않는다 — 오디는 콘텐츠를 만들 때 참고한 여러 Source 중 하나이고,
`story.sources` 에 출처로만 남는다.

`script` 하나가 **화면 자막이자 TTS 원문**이다. 둘이 갈라지면 듣는 말과 보이는
글이 달라진다. 그래서 클라이언트에 자막용·음성용을 따로 주지 않는다.

## ⚠️ 클라이언트가 텍스트를 보내지 않는다

`play_id` 와 `story_id` 만 받는다. 클라이언트가 긴 문자열을 업로드하게 만들면
**우리 Typecast 크레딧으로 아무 문장이나 읽게 되고**, 목소리 통제도 클라이언트로
넘어간다. 읽을 수 있는 것은 우리 원고에 있는 문장뿐이다.

오디(Odii) 대본을 읽던 `/tts/odii` 는 2026-09-11 에 걷어냈다 — 앱에서 부르는 곳이 없었다.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from slowapi import Limiter
from slowapi.util import get_remote_address

from services import typecast
from services.db import get_db_connection

router = APIRouter(prefix="/tts", tags=["tts"])
limiter = Limiter(key_func=get_remote_address)
logger = logging.getLogger(__name__)

# 감정 프리셋 화이트리스트. 클라이언트가 아무 문자열이나 넣어 Typecast에서
# 400을 받는 대신 여기서 막는다.
ALLOWED_EMOTIONS = {"normal", "happy", "sad", "angry", "whisper", "toneup", "tonedown"}


def resolve_line(play, line: str) -> str:
    """대사 열쇠 → 곱딱이가 읽을 문장. **화면 자막과 같은 문장**이어야 한다.

    iOS `PlayRunnerView.speechSection` 이 단계마다 보여주는 말을 그대로 재현한다
    (2026-09-11 조익준님 결정: 곱딱이가 말하는 모든 말을 음성으로).
    열쇠 형식:

        point:<point_id>              안내 — navigation_text, 없으면 objective
        mission:<mission_id>:<step>   미션 — 첫 Step 은 mission.prompt + 빈 줄 + step.prompt
        feedback:<mission_id>:<step>  정답 뒤 한마디 — step.success_feedback
        discovery:<mission_id>        발견 — mission.discovery.body
        story:<story_id>              이야기 — story.script
        final                         마지막 과제 — final.prompt
        clear                         완주 — clear.body

    모르는 열쇠·빈 문장은 ValueError. 클라이언트가 보낸 문장은 절대 읽지 않는다.
    """
    parts = line.split(":")
    kind = parts[0]

    def mission_of(mid: str):
        for pt in play.points:
            for m in pt.missions:
                if m.id == mid:
                    return m
        raise ValueError("그런 미션이 없습니다")

    def step_of(m, idx_s: str):
        try:
            idx = int(idx_s)
        except ValueError:
            raise ValueError("Step 번호가 아닙니다")
        if not (0 <= idx < len(m.steps)):
            raise ValueError("그런 Step 이 없습니다")
        return idx, m.steps[idx]

    if kind == "point" and len(parts) == 2:
        pt = next((x for x in play.points if x.id == parts[1]), None)
        if pt is None:
            raise ValueError("그런 Point 가 없습니다")
        text = pt.navigation_text or pt.objective
    elif kind == "mission" and len(parts) == 3:
        m = mission_of(parts[1]); idx, step = step_of(m, parts[2])
        if idx == 0 and m.prompt:
            text = m.prompt if not step.prompt else m.prompt + "\n\n" + step.prompt
        else:
            text = step.prompt or m.prompt
    elif kind == "feedback" and len(parts) == 3:
        m = mission_of(parts[1]); _, step = step_of(m, parts[2])
        text = step.success_feedback
    elif kind == "discovery" and len(parts) == 2:
        m = mission_of(parts[1])
        text = m.discovery.body if m.discovery else ""
    elif kind == "story" and len(parts) == 2:
        st = next((x for x in play.stories if x.id == parts[1]), None)
        if st is None:
            raise ValueError("그런 이야기가 없습니다")
        text = st.script
    elif kind == "final" and len(parts) == 1:
        text = play.final.prompt if play.final else ""
    elif kind == "clear" and len(parts) == 1:
        text = play.clear.body if play.clear else ""
    else:
        raise ValueError("모르는 대사 열쇠입니다")

    text = (text or "").strip()
    if not text:
        raise ValueError("읽을 문장이 없습니다")
    return text


def _synth_response(conn, text: str, emotion: str) -> Response:
    try:
        audio, from_cache = typecast.synth(text, emotion=emotion, lang="kor", conn=conn)
    except typecast.TtsError as e:
        # 조용히 빈 응답을 주지 않는다. 재생이 안 되면 안 되는 이유가 보여야 한다.
        raise HTTPException(status_code=502, detail=str(e))
    # ⚠️ HTTP 헤더는 latin-1 만 담는다. 한글을 넣으면 500 이 난다(2026-08-20 실측).
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "public, max-age=604800",
            "X-Tts-Cache": "hit" if from_cache else "miss",
        },
    )


def _load_play(play_id: str):
    from services import place_registry as registry
    from services import play_loader

    conn = get_db_connection()
    registry.ensure_synced(conn)
    play = play_loader.get(conn, play_id)
    if play is None:
        raise HTTPException(status_code=404, detail="그런 PLAY 가 없습니다")
    return conn, play


@router.get("/line")
@limiter.limit("120/minute")
def tts_for_line(request: Request, play_id: str, line: str,
                 emotion: str = "normal") -> Response:
    """PLAY 원고의 곱딱이 대사 한 줄을 음성으로 돌려준다.

    ⚠️ 읽을 문장을 **클라이언트가 보내지 않는다.** PLAY id 와 대사 열쇠만 받는다
    (열쇠 형식은 `resolve_line`). 그래야 우리 Typecast 크레딧으로 아무 문장이나
    읽히는 일이 없다. 단계마다 자동 재생되므로 분당 한도를 이야기보다 넉넉히 둔다.
    """
    if emotion not in ALLOWED_EMOTIONS:
        raise HTTPException(status_code=400, detail=f"모르는 감정: {emotion}")
    conn, play = _load_play(play_id)
    try:
        text = resolve_line(play, line)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _synth_response(conn, text, emotion)


@router.get("/story")
@limiter.limit("60/minute")
def tts_for_story(request: Request, play_id: str, story_id: str,
                  emotion: str = "normal") -> Response:
    """PLAY 원고의 Story 하나를 음성으로 돌려준다. `/tts/line?line=story:<id>` 와 같다 —
    옛 클라이언트 호환용으로 남겨 둔다.
    """
    if emotion not in ALLOWED_EMOTIONS:
        raise HTTPException(status_code=400, detail=f"모르는 감정: {emotion}")
    conn, play = _load_play(play_id)
    try:
        text = resolve_line(play, f"story:{story_id}")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _synth_response(conn, text, emotion)
