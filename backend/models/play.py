"""PLAY 콘텐츠 모델 — 관광지 하나를 게임으로 만드는 데이터 구조.

## 구조

    PLAY
     └─ Point          사용자가 실제로 이동해 도착하는 장소 단위
         └─ Mission    그 자리에서 현실을 보고 하는 행동·발견 단위
             └─ Step   미션 하나 안의 진행 단계

**Mission 하나 ≠ 화면 하나다.** 호령창 미션은 `찾았어요 → 어느 쪽 → 왜`
세 Step이 모여 하나다. 이걸 `missionType = "choice"` 같은 단일 타입으로 박으면
좋은 미션을 만들 수 없다.

## Challenge Pattern 과 Input 은 다른 축이다

    Challenge Pattern   현실에서 사용자가 하는 행동  (콘텐츠 메타데이터)
                        FIND · COUNT · READ · COMPARE · FOLLOW · ORDER · DECODE · INFER

    Input               폰에 답을 넣는 방법        (화면을 결정하는 것)
                        CONFIRM · CHOICE · DIRECTION · NUMBER · SHORT_TEXT · MATCH_ORDER

화면을 고르는 것은 **Step 의 `input_type` 하나뿐**이다. Pattern 은 미션을
설계·검수할 때 쓰는 이름표이지 UI를 결정하지 않는다.

## Story 는 오디 원문이 아니다 (2026-09-02 결정)

전에는 `미션 클리어 → 오디 대본 재생` 이었다. 폐기했다.

이제 Story 는 **놀멍봅서가 직접 쓴 문장**이다. 오디·KTO·국가유산·지자체·
한국민족문화대백과 같은 자료를 **교차검증한 결과**를 우리 문장으로 쓴다.
오디 `stid` 는 자동재생용이 아니라 `sources` 에 남기는 **출처 메타데이터**다.

`script` 하나가 **화면 자막이자 TTS 원문**이다. 둘이 갈라지면 듣는 말과
보이는 글이 달라진다.

## Place 와 PLAY 는 다른 것이다

`Play.place_id` 는 놀멍봅서가 발급한 **불변 Place ID**를 가리킨다
(`services/place_registry.py`). 오디 `stid` 나 KTO `contentId` 를 쓰지 않는다 —
Place 의 정체성이 특정 공급자에 종속되면 안 된다.

한 Place 에 PLAY 가 여러 개 생길 수 있다(제주돌문화공원 → 야외전시장 /
신화의 정원 / 초가마을). 그래서 `Place 1 : N PLAY` 다.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

# ── 어휘 ──────────────────────────────────────────────────────────────────────

ChallengePattern = Literal[
    "FIND", "COUNT", "READ", "COMPARE", "FOLLOW", "ORDER", "DECODE", "INFER"
]

InputType = Literal[
    "CONFIRM",      # [찾았어요] — 항상 통과한다. 다음 Step 이 진짜 검증을 한다
    "CHOICE",       # 보기 선택. 글자 보기와 그림 보기를 모두 지원한다
    "DIRECTION",    # 왼쪽 / 오른쪽 / 위 / 아래
    "NUMBER",       # 개수 세기
    "SHORT_TEXT",   # 현판·각인처럼 짧고 명확한 답
    "MATCH_ORDER",  # 짝 맞추기 또는 순서 세우기. Final 에 쓴다
]

Difficulty = Literal["쉬움", "보통", "어려움"]

Direction = Literal["LEFT", "RIGHT", "UP", "DOWN"]


# ── 출처 ──────────────────────────────────────────────────────────────────────

class SourceRef(BaseModel):
    """이 이야기를 쓸 때 참고한 자료.

    **자동 재생용이 아니다.** 사실 확인과 출처 표기에 쓴다.
    """
    kind: str                 # odii | kto | heritage | encykorea | local_gov | other
    ref: str = ""             # stid · contentId · URL 등
    note: str = ""


# ── Step ──────────────────────────────────────────────────────────────────────

class Option(BaseModel):
    """CHOICE / MATCH_ORDER 의 보기 하나."""
    id: str
    label: str
    # 그림 보기. 배치도처럼 글자로 설명하기 어려운 것에 쓴다.
    # ⚠️ **미션의 답이 되는 현실물을 그림으로 대체하지 않는다.**
    # 앱이 정답을 대신 보여주면 `관찰 → 발견 → 의미` 가 깨진다.
    image: Optional[str] = None


class Step(BaseModel):
    """미션 하나 안의 진행 단계.

    `answer` 의 모양은 `input_type` 에 따라 다르다.

    | input_type   | answer                                         |
    |--------------|------------------------------------------------|
    | CONFIRM      | 없음 (누르면 통과)                              |
    | CHOICE       | 정답 Option 의 `id` (문자열)                    |
    | DIRECTION    | `LEFT` `RIGHT` `UP` `DOWN`                     |
    | NUMBER       | 정수                                           |
    | SHORT_TEXT   | 허용 답안 목록 — 표기가 갈리는 답을 다 받아준다 |
    | MATCH_ORDER  | 순서면 `["a","b"]`, 짝이면 `["a>x","b>y"]`     |
    """
    input_type: InputType
    prompt: str
    options: list[Option] = Field(default_factory=list)
    # 짝 맞추기의 오른쪽 항목. MATCH_ORDER 가 '순서'가 아니라 '짝'일 때만 쓴다.
    match_targets: list[Option] = Field(default_factory=list)
    answer: Any = None
    success_feedback: str = ""
    # 오답 문구. 비워두면 화면이 공용 문구를 쓴다 —
    # "틀렸습니다"가 아니라 "아직 아닌 것 같아요. 실제 대상을 다시 살펴보세요."
    failure_feedback: str = ""

    @model_validator(mode="after")
    def _check_answer_shape(self) -> "Step":
        t, a = self.input_type, self.answer

        if t == "CONFIRM":
            return self  # 답이 필요 없다

        if t == "CHOICE":
            ids = {o.id for o in self.options}
            if len(self.options) < 2:
                raise ValueError("CHOICE 는 보기가 2개 이상이어야 합니다")
            if not isinstance(a, str) or a not in ids:
                raise ValueError(f"CHOICE 의 answer 는 보기 id 중 하나여야 합니다: {ids}")

        elif t == "DIRECTION":
            if a not in ("LEFT", "RIGHT", "UP", "DOWN"):
                raise ValueError("DIRECTION 의 answer 는 LEFT/RIGHT/UP/DOWN 입니다")

        elif t == "NUMBER":
            if not isinstance(a, int) or isinstance(a, bool):
                raise ValueError("NUMBER 의 answer 는 정수여야 합니다")

        elif t == "SHORT_TEXT":
            if not isinstance(a, list) or not a or not all(isinstance(x, str) for x in a):
                raise ValueError(
                    "SHORT_TEXT 의 answer 는 허용 답안 문자열 목록이어야 합니다. "
                    "표기가 갈리는 답 때문에 정답을 못 맞히는 일이 제일 흔합니다"
                )

        elif t == "MATCH_ORDER":
            if not isinstance(a, list) or not a:
                raise ValueError("MATCH_ORDER 의 answer 는 비어 있을 수 없습니다")
            if self.match_targets:
                target_ids = {o.id for o in self.match_targets}
                opt_ids = {o.id for o in self.options}
                for pair in a:
                    if not isinstance(pair, str) or ">" not in pair:
                        raise ValueError("짝 맞추기의 answer 는 '보기id>대상id' 형식입니다")
                    left, right = pair.split(">", 1)
                    if left not in opt_ids or right not in target_ids:
                        raise ValueError(f"짝 {pair} 의 id 가 보기 목록에 없습니다")
            else:
                opt_ids = {o.id for o in self.options}
                if set(a) != opt_ids:
                    raise ValueError("순서 세우기의 answer 는 보기 id 전부를 한 번씩 써야 합니다")

        return self


# ── Mission ───────────────────────────────────────────────────────────────────

class Hint(BaseModel):
    """단계 힌트.

    1번은 **어디를 볼지**, 2번은 **무엇을 볼지**. 순서가 바뀌면 1번에서 답이 새어
    2번이 할 일이 없어진다.
    """
    text: str


class Discovery(BaseModel):
    """미션을 풀고 나서 뜨는 「발견」 화면.

    **제목은 이름 있는 사물에만 붙인다.** 정본은 「NEW DISCOVERY — 정주석」처럼
    정주석·물팡·호령창에만 이름표를 주고, 「마당 배치」나 「세대별 살림」 같은
    관찰 결과에는 안 준다. 없는 이름을 지어내면 사용자가 못 들어본 낱말을
    발견한 것처럼 읽힌다.
    """
    title: str = ""            # 예: 호령창. 이름 있는 사물일 때만
    body: str = ""             # 한두 줄. 긴 설명은 Story 가 맡는다


VerificationLevel = Literal["strong", "likely", "unverified"]
"""웹 검증 등급 (현장 답사를 하지 않기로 한 2026-09-02 결정에 따른 것).

- `strong`      실물·위치·특징·의미를 공신력 있는 자료로 확인
- `likely`      존재·위치는 확인했으나 **일반 관람객 시야에서 보이는지**는 미확정
- `unverified`  V1 Main Mission 에 쓰지 않는다

`likely` 인 미션은 현장에서 못 찾을 수 있다. 그래서 힌트·건너뛰기·신고가
**있어야 성립한다.** 신고 데이터를 콘텐츠 QA 에 되먹인다.
"""


class Mission(BaseModel):
    id: str
    title: str
    # 현실에서 하는 행동. 화면을 결정하지 않는다 — 검수용 이름표다.
    patterns: list[ChallengePattern] = Field(default_factory=list)
    prompt: str = ""
    steps: list[Step] = Field(default_factory=list)
    hints: list[Hint] = Field(default_factory=list)
    discovery: Optional[Discovery] = None
    # 이 미션을 풀면 채워지는 진행도 칸의 id. 없으면 진행도가 안 움직인다.
    # (앞 미션이 뒤 미션의 준비인 경우가 있다 — 성읍 M01·M05 가 그렇다)
    progress_reward: Optional[str] = None
    verification: VerificationLevel = "strong"
    # 심사·데모에서 하나만 보여준다면 이것. 성읍은 호령창(M08)이다.
    is_showcase: bool = False

    @model_validator(mode="after")
    def _check(self) -> "Mission":
        if not self.steps:
            raise ValueError(f"미션 {self.id} 에 Step 이 없습니다")
        if len(self.hints) > 2:
            raise ValueError(
                f"미션 {self.id} 의 힌트가 {len(self.hints)}개입니다. "
                "힌트는 '어디를' · '무엇을' 두 단계다"
            )
        return self


# ── Point ─────────────────────────────────────────────────────────────────────

class Point(BaseModel):
    """사용자가 실제로 걸어가 도착하는 장소 단위.

    좌표는 **도착 판정용이 아니라 안내용**이다. 성읍은 Point 사이가 52m밖에
    안 돼서 GPS(±10~30m)로는 구분할 수 없다. 진행은 `[도착했어요]` 가 한다.
    """
    id: str
    title: str
    objective: str = ""         # 이번 Point 에서 무엇을 조사하는가
    lat: Optional[float] = None
    lng: Optional[float] = None
    navigation_text: str = ""   # "마을 안쪽으로 100m, 왼편 초가"
    intro: str = ""             # 도착 직후 한 줄
    missions: list[Mission] = Field(default_factory=list)


# ── Story ─────────────────────────────────────────────────────────────────────

class Story(BaseModel):
    """발견의 의미. **놀멍봅서가 직접 쓴 문장이다.**

    `script` 하나가 화면 자막이자 TTS 원문이다.
    기본 15~35초, 중요한 것도 45초 이내를 목표로 한다.

    미션마다 하나씩 붙이지 않는다. 여러 미션이 하나의 의미를 만들면
    마지막 미션 뒤에 하나만 붙인다.
    """
    id: str
    title: str = ""
    script: str
    sources: list[SourceRef] = Field(default_factory=list)
    # 이 미션을 끝내면 열린다.
    unlock_after_mission: str


# ── Final · Clear ─────────────────────────────────────────────────────────────

class FinalStage(BaseModel):
    """마지막 조립. **새 잡학 문제를 내지 않는다.**

    지금까지 사용자가 직접 발견한 것을 다시 이어 붙여 하나의 의미로 만든다.

    **FINAL 뒤에 이야기를 끼우지 않는다** (2026-09-29 결정). FINAL 을 맞히면 바로
    CLEAR 로 가고, 마무리 글은 `clear.body` 한 곳이 맡는다. 원고에 `story` 칸을
    적으면 서버가 뜨기 전에 거부한다 — 모르는 칸을 조용히 버리면 쓴 사람은
    나온다고 믿는데 화면엔 안 나온다.
    """
    model_config = ConfigDict(extra="forbid")

    id: str = "final"
    title: str
    prompt: str = ""
    step: Step
    # 2026-09-07 추가. FINAL 도 다른 Mission 처럼 힌트 2단계를 갖는다.
    hints: list[Hint] = Field(default_factory=list)


class ClearStage(BaseModel):
    """엔딩. "문제를 다 풀었습니다"가 아니라 **이 장소를 보는 눈을 얻었다**로 끝낸다."""
    title: str
    body: str


# ── 진행도 ────────────────────────────────────────────────────────────────────

class ProgressRecord(BaseModel):
    """이번 PLAY 에서 실제로 모으는 것 한 칸.

    XP·코인 같은 범용 점수를 쓰지 않는다. 성읍은 「생활기록 6칸」이고
    다른 PLAY 는 다른 것을 모은다.
    """
    id: str
    label: str


# ── PLAY ──────────────────────────────────────────────────────────────────────

class Play(BaseModel):
    id: str
    # 원고가 Place 를 가리키는 방법. `data/places.json` 의 자체 키다.
    # ⚠️ 오디 stid 같은 외부 ID 로 가리키지 않는다 — 그 공급자를 끊는 순간
    # Place 를 못 찾게 된다 (2026-09-02 결정).
    place_key: str
    # 불러올 때 레지스트리가 채운다. 저장된 PLAY 가 FK 로 무는 값이다.
    place_id: str = ""
    place_name: str = ""        # 화면 표시용. identity 가 아니다

    title: str                  # 「성읍 생활기록 복원작전」
    objective: str = ""         # 이번 PLAY 에서 할 일 한 줄
    # 카드에 들어가는 두 줄짜리 요약.
    #
    # `objective` 는 정본 문장이라 길다 — 카드에서는 「경계 / 출입 / 공간 / …」
    # 목록이 잘려 «복원하…» 로 끝난다. 시안이 쓰는 짧은 판을 따로 둔다.
    # 비어 있으면 화면이 `objective` 를 잘라 쓴다.
    card_summary: str = ""

    estimated_minutes_min: int
    estimated_minutes_max: int
    distance_meters: int
    difficulty: Difficulty
    # 난이도 별 (1~5). 홈 카드가 쓴다.
    #
    # `difficulty` 글자와 같은 것을 두 가지로 표현한다 — 카드는 별, 상세는 글자.
    # 5단계 척도는 **콘텐츠를 만들면서 PLAY 끼리 견줘 정한다**(2026-09-02 결정).
    # 지금은 성읍 하나뿐이라 기준점이 없다. 두 번째 PLAY 를 만들 때 다시 본다.
    difficulty_stars: int = Field(default=0, ge=0, le=5)

    progress_label: str = ""    # 「생활기록」
    progress_records: list[ProgressRecord] = Field(default_factory=list)

    # 시작 버튼 문구. **Game Fantasy 의 일부다** (2026-09-02 결정).
    #

    # 탐험 경로를 PLAY 상세에서 미리 다 보여줄지.
    # 성읍은 FULL 이다 — 이 PLAY 의 재미는 다음 목적지를 추리하는 데 있지 않고
    # 각 Point 에 도착해서 현실을 관찰하는 데 있다.
    route_reveal_mode: Literal["FULL", "PROGRESSIVE"] = "FULL"

    start_name: str = ""
    start_lat: Optional[float] = None
    start_lng: Optional[float] = None
    finish_name: str = ""


    points: list[Point] = Field(default_factory=list)
    stories: list[Story] = Field(default_factory=list)
    final: Optional[FinalStage] = None
    clear: Optional[ClearStage] = None

    # ── 파생값 ──
    @property
    def mission_count(self) -> int:
        return sum(len(p.missions) for p in self.points)

    @model_validator(mode="after")
    def _check(self) -> "Play":
        if not self.points:
            raise ValueError(f"PLAY {self.id} 에 Point 가 없습니다")

        mission_ids = [m.id for p in self.points for m in p.missions]
        dup = {m for m in mission_ids if mission_ids.count(m) > 1}
        if dup:
            raise ValueError(f"미션 id 가 겹칩니다: {dup}")

        # Story 가 없는 미션을 가리키면 영원히 안 열린다.
        known = set(mission_ids)
        for s in self.stories:
            if s.unlock_after_mission not in known:
                raise ValueError(
                    f"Story {s.id} 가 없는 미션({s.unlock_after_mission})을 가리킵니다"
                )

        # 진행도 칸을 미션이 하나도 안 채우면 6/6 이 될 수 없다.
        rewards = {m.progress_reward for p in self.points for m in p.missions}
        rewards |= {self.final.id} if self.final else set()
        for rec in self.progress_records:
            if rec.id not in rewards:
                raise ValueError(
                    f"진행도 칸 '{rec.id}' 를 채우는 미션이 없습니다. "
                    "끝까지 가도 100%가 안 됩니다"
                )
        return self


# ── 목록·지도용 요약 ──────────────────────────────────────────────────────────

class PlaySummary(BaseModel):
    """홈 카드·지도 핀·장소 상세가 쓰는 가벼운 형태."""
    id: str
    place_id: str
    # 픽셀 커버 파일 이름이기도 하다 (`Resources/Covers/<place_key>.png`).
    place_key: str = ""
    place_name: str
    title: str
    objective: str = ""
    card_summary: str = ""
    estimated_minutes_min: int
    estimated_minutes_max: int
    distance_meters: int
    difficulty: Difficulty
    difficulty_stars: int = 0
    mission_count: int
    thumbnail: Optional[str] = None


class MapPin(BaseModel):
    """PLAY 지도 핀 하나.

    `status` 가 `active` 면 지금 플레이할 수 있고, `preparing` 이면 후보다.
    **색만으로 구분하지 않는다** — 화면에서 모양도 다르게 그린다.
    색각 이상이 있는 사용자에게 두 상태가 같아 보이면 안 된다.
    """
    place_id: str
    place_key: str = ""
    place_name: str
    lat: float
    lng: float
    status: Literal["active", "preparing"]
    # 준비 중인 곳도 카드에 사진이 필요하다. PLAY 요약에만 두면 준비 중 카드가 빈다.
    thumbnail: Optional[str] = None
    play: Optional[PlaySummary] = None
    # 지도에는 다 뜨지만 홈 「수행 가능한 퀘스트」에는 일부만 노출한다 —
    # 콘텐츠 제작 착수 전 후보지까지 퀘스트 카드로 보이면 안 된다.
    home_visible: bool = True
