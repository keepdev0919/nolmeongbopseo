"""PLAY 엔진 — 되돌리면 안 되는 결정을 지키는 테스트.

버그를 잡으려는 테스트가 아니다. 세션이 끊기면 다음 세션의 나는 오늘의 결정을
모른다. **"이 값을 함부로 바꾸지 마라, 이유는 이거다"를 코드에 박아두는 장치**다.
그래서 docstring 에 왜 그 값인지를 반드시 적는다 (CLAUDE.md).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR / "backend"))

from models.play import Play, Step  # noqa: E402
from services import place_registry as registry  # noqa: E402
from services import play_loader  # noqa: E402
from services.db import get_db_connection  # noqa: E402


@pytest.fixture(scope="module")
def conn():
    c = get_db_connection()
    registry.ensure_synced(c)
    return c


@pytest.fixture(scope="module")
def seongeup(conn) -> Play:
    play = play_loader.get(conn, "seongeup-restore")
    assert play is not None, "성읍 PLAY 원고를 못 읽었습니다"
    return play


# ── Place 정체성 ──────────────────────────────────────────────────────────────

SEONGEUP_KEY = "seongeup-folk-village"


class TestPlaceIdentity:
    """**놀멍봅서 Place 의 정체성은 어느 공급자에도 종속되지 않는다** (2026-09-02 결정).

    Odii `stid` 를 Place 를 찾는 열쇠로 쓰는 안을 잠깐 썼다가 걷어냈다.
    오디는 이제 콘텐츠 조사 Source 중 하나일 뿐인데, 그것으로 Place 를 찾게
    만들면 **오디를 안 쓰는 순간 장소를 못 찾는다.** 열쇠는 우리가 쥔다.
    """

    def test_place_id_는_우리가_발급한다(self, conn):
        place = registry.by_key(conn, SEONGEUP_KEY)
        assert place is not None
        pid = place["id"]
        assert len(pid) == 36 and pid.count("-") == 4, "uuid 형식이어야 합니다"
        # 어떤 외부 ID 와도 같지 않다
        assert pid not in {e["external_id"] for e in place["external_ids"]}

    def test_외부_id_없이도_place_가_성립한다(self, conn):
        """외부 ID 는 **바깥 자료로 가는 다리이지 정체성이 아니다** (데이터.md §3).

        오디에도 KTO 에도 없는 장소를 나중에 PLAY 로 만들 수 있어야 한다.
        """
        pid = registry.ensure_by_key(
            conn, place_key="test-no-external", display_name="외부ID없는곳",
            lat=33.0, lng=126.0,
        )
        assert registry.get(conn, pid)["external_ids"] == []
        conn.execute("DELETE FROM places WHERE place_key = ?", ("test-no-external",))
        conn.commit()

    def test_한_place_에_여러_외부_id_를_붙일_수_있다(self, conn):
        """KTO contentId + Odii stid + 국가유산 ID 를 같이 붙일 수 있어야 한다."""
        pid = registry.by_key(conn, SEONGEUP_KEY)["id"]
        registry.link_external(conn, pid, registry.SOURCE_KTO, "test-kto-1")
        assert registry.external_ids(conn, pid, registry.SOURCE_KTO) == ["test-kto-1"]
        conn.execute("DELETE FROM place_external_ids WHERE external_id = ?", ("test-kto-1",))
        conn.commit()

    def test_한_외부_id_는_한_place_에만_붙는다(self, conn):
        """같은 ID 가 두 Place 를 오가면 어느 장소의 자료인지 알 수 없게 된다."""
        other = registry.new_place_id()
        with pytest.raises(ValueError):
            registry.link_external(conn, other, registry.SOURCE_ODII, "2166")

    def test_다시_동기화해도_place_id_가_그대로다(self, conn):
        """place_id 는 PLAY 와 사용자 진행 기록이 FK 로 물고 있다.
        재발급되면 전부 미아가 된다.
        """
        before = registry.by_key(conn, SEONGEUP_KEY)["id"]
        registry.sync_from_file(conn)
        assert registry.by_key(conn, SEONGEUP_KEY)["id"] == before

    def test_이름은_identity_가_아니다(self, conn):
        """이름이 바뀌어도 Place 는 같아야 한다.

        전에는 이름 문자열이 사실상 키였다 — `home_stage.json` 의 name 이
        `home_places.name` 과 한 글자만 달라도 카드가 조용히 사라졌다.
        """
        pid = registry.by_key(conn, SEONGEUP_KEY)["id"]
        conn.execute("UPDATE places SET display_name = ? WHERE id = ?", ("잠깐다른이름", pid))
        assert registry.by_key(conn, SEONGEUP_KEY)["id"] == pid
        conn.commit()
        registry.sync_from_file(conn)  # 이름을 되돌린다

    def test_오디_없이도_place_를_찾을_수_있다(self, conn):
        """열쇠가 place_key 이지 stid 가 아니라는 것을 못 박는다.

        여기가 무너지면 "오디를 끊으면 장소가 사라지는" 구조로 되돌아간다.
        """
        pid = registry.by_key(conn, SEONGEUP_KEY)["id"]
        conn.execute("DELETE FROM place_external_ids WHERE place_id = ?", (pid,))
        assert registry.by_key(conn, SEONGEUP_KEY)["id"] == pid
        conn.commit()
        registry.sync_from_file(conn)  # 다리를 되돌린다


# ── PLAY ↔ Place ──────────────────────────────────────────────────────────────

class TestPlayReferencesPlaceId:
    def test_play_는_place_id_를_fk_로_문다(self, conn, seongeup):
        """PLAY 가 외부 ID 를 직접 물면 공급자 교체가 불가능해진다.

        원고 파일에는 우리 자체 키(`seongeup-folk-village`)로 적고,
        불러올 때 레지스트리가 place_id 로 바꾼다.
        """
        assert seongeup.place_id
        assert seongeup.place_key == SEONGEUP_KEY
        assert seongeup.place_id != seongeup.place_key
        assert registry.get(conn, seongeup.place_id) is not None

    def test_place_에서_play_를_찾을_수_있다(self, conn, seongeup):
        """`Place 1 : N PLAY`. 장소 상세의 「이 장소에서 할 수 있는 PLAY」 섹션이 쓴다."""
        plays = play_loader.for_place(conn, seongeup.place_id)
        assert [p.id for p in plays] == ["seongeup-restore"]


# ── 지도 ──────────────────────────────────────────────────────────────────────

class TestMapIsPlayMap:
    """지도가 답하는 질문이 바뀌었다 (2026-09-02).

      전: "제주에 오디 해설이 몇 개 있나"  → 핀 121개
      후: "제주 어디서 놀멍봅서를 할 수 있고 앞으로 어디에 생기나"

    오디 121곳은 **내부 콘텐츠 후보 Pool 로만** 남는다.
    """

    def test_오디_장소를_사용자에게_뿌리지_않는다(self, conn):
        """지도에 뜨는 것은 `data/places.json` 이 선언한 곳뿐이다.

        오디에 해설이 있다는 이유만으로 공개 지도에 표시하지 않는다 (데이터.md §11).
        여기가 무너지면 "PLAY 몇 곳"이 "해설 121곳"에 묻혀 안 보인다.
        """
        pins = play_loader.map_pins(conn)
        assert len(pins) <= 20, f"핀이 {len(pins)}개입니다. 오디 전체가 새어 나왔습니다"

    def test_candidate_는_지도에_안_뜬다(self, conn):
        """CANDIDATE = 후속 검토. 아직 알리지 않기로 한 곳이다 (콘텐츠후보지.md §4)."""
        shown = {p.place_id for p in play_loader.map_pins(conn)}
        for place in registry.all_places(conn, registry.STATUS_CANDIDATE):
            assert place["id"] not in shown

    def test_활성_핀에는_play_가_준비중_핀에는_없다(self, conn):
        """핀을 눌렀을 때 보여줄 것이 상태마다 다르다.
        활성이면 PLAY 정보, 준비 중이면 장소 이름과 「준비 중」이다.
        """
        pins = play_loader.map_pins(conn)
        for pin in pins:
            if pin.status == "active":
                assert pin.play is not None and pin.play.mission_count > 0
            else:
                assert pin.play is None

    def test_핀_좌표가_비어_있지_않다(self, conn):
        pins = play_loader.map_pins(conn)
        assert pins
        assert all(p.lat and p.lng for p in pins)


# ── 성읍 콘텐츠 ───────────────────────────────────────────────────────────────

class TestSeongeupContent:
    """`docs/기획/콘텐츠/성읍민속마을.md` 가 정본이다. 여기 숫자는 그 문서의 결정이다."""

    def test_구성이_정본과_같다(self, seongeup):
        """4 Point · 8 Main Mission · 5 Story · 생활기록 6칸.

        Mission 을 9개로 맞추려고 약한 문제를 넣지 않기로 했다 —
        정본 §17 「현재 제외 소재」(돈궤·돌구유·통시 등)가 그 결정의 기록이다.
        """
        assert len(seongeup.points) == 4
        assert seongeup.mission_count == 8
        assert len(seongeup.stories) == 5
        assert len(seongeup.progress_records) == 6

    def test_진행도_6칸이_전부_채워질_수_있다(self, seongeup):
        """끝까지 갔는데 5/6 에서 멈추면 CLEAR 화면의 "6 / 6 RESTORED"가 거짓이 된다."""
        rewards = {m.progress_reward for p in seongeup.points for m in p.missions}
        assert {r.id for r in seongeup.progress_records} <= rewards

    def test_m05_는_방향_정답을_쓰지_않는다(self, seongeup):
        """정본 §M05 「방향 정답 사용 금지」.

        자료마다 안거리·밖거리의 좌/우 설명이 엇갈린다. 방향으로 물으면
        현장에서 맞는 답이 틀린 것으로 처리될 수 있다. 대신 "두 집채가
        마주 보는 구조"를 관찰하게 한다.
        """
        m05 = next(m for p in seongeup.points for m in p.missions if m.id == "m05")
        assert all(s.input_type != "DIRECTION" for s in m05.steps)

    def test_discovery_없는_미션이_있어도_된다(self, seongeup):
        """콘텐츠.md §13 (2026-09-02 개정).

        **모든 Mission 은 발견에 기여해야 하지만, 모든 Mission 이 독립적인
        Discovery 를 가질 필요는 없다.**

        M01 은 "대문이 없다"는 관찰로 M02 의 질문을 만든다. 여기에 억지로
        Discovery 를 붙이면 **아직 발견하지 않은 것을 발견했다고 말하게 된다.**
        나중에 이 자리를 "빠진 것"으로 보고 채우지 않도록 못 박아 둔다.
        """
        m01 = next(m for p in seongeup.points for m in p.missions if m.id == "m01")
        assert m01.discovery is None
        assert m01.progress_reward is None
        # 대신 바로 다음 미션이 발견을 만든다
        m02 = next(m for p in seongeup.points for m in p.missions if m.id == "m02")
        assert m02.discovery is not None and m02.progress_reward == "boundary"

    def test_시작_버튼_문구를_원고가_정하지_않는다(self):
        """**모든 PLAY 가 같은 시작 버튼을 쓴다** (2026-09-03 결정).

        전에는 원고마다 세계관 말(`[복원 시작]`)을 따로 정했다. PLAY 가 늘수록
        같은 자리의 버튼이 매번 달라 보였다. 지금은 화면이 「플레이하기」·
        「이어서 하기」·「다시 하기」 세 말만 고정으로 쓴다 — 어느 것이 뜰지는
        진행 저장 상태가 정하고, 원고는 관여하지 않는다.

        원고에 버튼 문구가 다시 생기면 그 통일이 조용히 깨지므로 여기서 막는다.
        """
        for path in sorted(play_loader.PLAY_DIR.glob("*.json")):
            raw = json.loads(path.read_text(encoding="utf-8"))
            assert "start_cta" not in raw, f"{path.name} 에 버튼 문구가 다시 생겼습니다"

    def test_대표_시연_미션은_호령창이다(self, seongeup):
        """심사위원에게 하나만 보여준다면 이것이다.

        "설명을 듣고 호령창을 아는 것"과 "직접 문을 들여다보다 작은 문을 발견한 뒤
        그게 무엇인지 알게 되는 것"의 차이가 제품 차별점을 그대로 보여준다.
        """
        showcase = [m for p in seongeup.points for m in p.missions if m.is_showcase]
        assert [m.id for m in showcase] == ["m08"]
        assert showcase[0].discovery.title == "호령창"

    def test_웹검증_유력_미션에는_힌트가_둘_다_있다(self, seongeup):
        """🟡 은 현장에서 못 찾을 수 있다는 뜻이다. 현장 답사를 하지 않기로 했으므로
        (2026-09-02) 힌트와 건너뛰기가 **없으면 그 미션이 성립하지 않는다.**
        """
        likely = [m for p in seongeup.points for m in p.missions
                  if m.verification == "likely"]
        assert {m.id for m in likely} == {"m04", "m07"}
        for m in likely:
            assert len(m.hints) == 2, f"{m.id} 의 힌트가 {len(m.hints)}개입니다"

    def test_final_은_직접_발견한_것만_묻는다(self, seongeup):
        """정본 §12 「신규 지식 출제: 금지」.

        Final 에서 새 잡학을 물으면 지금까지 현실을 본 경험이 시험으로 바뀐다.
        6개 전부가 앞에서 사용자가 직접 발견한 것이어야 한다.

        2026-09-07: 카테고리 짝짓기(match_targets)에서 「성읍 사람의 하루」
        순서 세우기로 바꿨다 — match_targets 는 비어 있고, answer 는 옵션
        id 를 하루 순서대로 나열한 것이다. 짝짓기든 순서든 answer 가 가리키는
        id 는 options 6개와 정확히 같아야 한다는 본질은 그대로다.
        """
        assert seongeup.final is not None
        step = seongeup.final.step
        assert step.input_type == "MATCH_ORDER"
        assert len(step.options) == 6
        assert len(step.answer) == 6
        option_ids = {o.id for o in step.options}
        answer_ids = {a.split(">")[0] for a in step.answer}
        assert answer_ids == option_ids

    def test_모든_미션에_힌트가_둘_있다(self, seongeup):
        """Hint 1 은 **어디를 볼지**, Hint 2 는 **무엇을 볼지**.
        하나뿐이면 그 하나가 답을 흘리게 된다.
        """
        for p in seongeup.points:
            for m in p.missions:
                assert len(m.hints) == 2, f"{m.id} 힌트 {len(m.hints)}개"


# ── Story 는 오디 원문이 아니다 ───────────────────────────────────────────────

class TestStoryIsOurs:
    """2026-09-02 결정. `미션 클리어 → 오디 대본 자동재생` 구조를 폐기했다.

    Story 는 오디·국가유산·한국민족문화대백과를 교차검증해 **놀멍봅서가 직접 쓴
    문장**이다. 오디 `stid` 는 출처 메타데이터로만 남는다.
    """

    def test_story_에_우리_문장이_들어_있다(self, seongeup):
        """script 가 비어 있고 stid 만 있으면 예전 구조(오디 자동재생)로 되돌아간 것이다."""
        for s in seongeup.stories:
            assert s.script.strip(), f"{s.id} 에 script 가 없습니다"

    def test_story_길이가_읽어줄_만하다(self, seongeup):
        """기본 15~35초, 중요한 것도 45초 이내 (정본 §5).

        한국어 TTS 는 대략 초당 5~6자다. 45초면 270자 안쪽이다. 길면 사용자가
        현실에서 눈을 떼고 서 있는 시간이 길어진다.
        """
        for s in seongeup.stories:
            assert len(s.script) <= 300, f"{s.id} 가 {len(s.script)}자입니다"

    def test_출처가_붙어_있다(self, seongeup):
        """Story 핵심 주장이 어디서 검증됐는지 추적 가능해야 한다 (정본 §18)."""
        for s in seongeup.stories:
            assert s.sources, f"{s.id} 에 출처가 없습니다"


# ── Story 음성 ────────────────────────────────────────────────────────────────

class TestStoryTTS:
    """`GET /tts/story?play_id=&story_id=`.

    **읽을 문장을 클라이언트가 보내지 않는다** (2026-09-02 결정).
    id 두 개만 받고 서버가 원고에서 꺼낸다.
    """

    def test_클라이언트가_읽을_텍스트를_못_보낸다(self):
        """여기가 무너지면 **우리 Typecast 크레딧으로 아무 문장이나 읽게 된다.**

        옛 `/tts/odii` 가 stid 만 받도록 만들어진 이유와 같다. 편의를 위해
        `text=` 파라미터를 열어주고 싶어지는데, 열면 되돌리기 어렵다.
        """
        import inspect
        from routers import tts
        params = inspect.signature(tts.tts_for_story).parameters
        assert "text" not in params and "script" not in params
        assert {"play_id", "story_id"} <= set(params)

    def test_모든_story_가_읽힌다(self, conn, seongeup):
        """화면이 열 수 있는 이야기는 전부 음성 경로가 있어야 한다.
        하나만 소리가 안 나면 현장에서 그 자리만 어색해진다.
        """
        from routers.tts import tts_for_story  # noqa: F401  (임포트만 확인)
        ids = {s.id for s in seongeup.stories}
        assert len(ids) == len(seongeup.stories), \
            "Story id 가 겹칩니다 — 겹치면 엉뚱한 음성이 재생된다"


# ── 모델 방어 ─────────────────────────────────────────────────────────────────

class TestModelGuards:
    """콘텐츠 원고의 실수를 서버가 뜨기 전에 잡는다. 잘못된 PLAY 는 현장에서
    사용자를 막아 세우는데, 그때는 고칠 수 없다.
    """

    def test_짧은_답은_허용_답안을_목록으로_받는다(self):
        """표기가 갈리는 답 때문에 정답을 못 맞히는 일이 제일 흔하다."""
        with pytest.raises(ValueError):
            Step(input_type="SHORT_TEXT", prompt="현판의 글자는?", answer="정의현")
        Step(input_type="SHORT_TEXT", prompt="현판의 글자는?", answer=["정의현", "旌義縣"])

    def test_보기에_없는_답을_막는다(self):
        with pytest.raises(ValueError):
            Step(input_type="CHOICE", prompt="?",
                 options=[{"id": "a", "label": "가"}, {"id": "b", "label": "나"}],
                 answer="c")

    def test_힌트_세_개를_막는다(self):
        """힌트는 '어디를'·'무엇을' 두 단계다. 셋째는 사실상 정답 공개이고,
        그건 `[정답과 이야기 보기]` 가 하는 일이다.
        """
        from models.play import Mission
        with pytest.raises(ValueError):
            Mission(id="x", title="x",
                    steps=[{"input_type": "CONFIRM", "prompt": "?"}],
                    hints=[{"text": "1"}, {"text": "2"}, {"text": "3"}])

    def test_FINAL_뒤_이야기를_막는다(self):
        """FINAL 을 맞히면 바로 CLEAR 로 간다 (2026-09-29 결정). FINAL 뒤 이야기 칸은
        없앴다 — 앱스토어에 나간 iOS 앱은 그 이야기를 읽은 뒤 FINAL 로 되돌아가
        CLEAR 에 닿지 못한다. 원고에 다시 적히면 서버가 뜨기 전에 막는다.
        """
        raw = json.loads((BASE_DIR / "data/plays/seongeup.json").read_text(encoding="utf-8"))
        raw = {k: v for k, v in raw.items() if not k.startswith("_")}
        assert "story" not in raw["final"]
        raw["final"]["story"] = {"id": "s-final", "title": "끝", "script": "끝.",
                                 "unlock_after_mission": "final"}
        with pytest.raises(ValueError):
            Play(**raw)

    def test_아무도_안_채우는_진행도_칸을_막는다(self):
        """끝까지 가도 100%가 안 되는 PLAY 를 배포하지 않는다."""
        raw = json.loads((BASE_DIR / "data/plays/seongeup.json").read_text(encoding="utf-8"))
        raw = {k: v for k, v in raw.items() if not k.startswith("_")}
        raw["progress_records"].append({"id": "nobody", "label": "아무도"})
        with pytest.raises(ValueError):
            Play(**raw)
