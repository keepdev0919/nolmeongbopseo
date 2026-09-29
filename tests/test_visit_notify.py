"""운영자 텔레그램 알림 — 출시된 앱의 요청을 보고 알린다 (services/visit_notify.py).

지키는 것:
1. 심사위원이 앱을 켜면 알림이 온다 — 30분 넘게 조용하다 오는 요청이 곧 새 방문이다.
2. 한 방문 안에서 같은 일은 한 번만 온다 — 화면을 오갈 때마다 폰이 울리면 안 된다.
3. 알림이 실패하거나 꺼져 있어도 앱 요청은 성공한다.
4. 헬스체크·처리방침 같은 앱 밖 요청은 방문으로 세지 않는다.
"""
import collections

import pytest

from services import admin_notify, visit_notify

PLAY_ID = "seongeup-restore"
T0 = 1_000_000.0


@pytest.fixture
def sent(monkeypatch):
    box: list[str] = []
    monkeypatch.setattr(visit_notify, "send_capped", lambda text: box.append(text) or True)
    monkeypatch.setattr(visit_notify, "_last_request_at", None)
    monkeypatch.setattr(visit_notify, "_notified", set())
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    return box


def test_first_request_announces_a_visit_and_what_was_opened(sent):
    visit_notify.observe("GET", f"/plays/{PLAY_ID}", "", now=T0)
    assert len(sent) == 1
    first, second = sent[0].split("\n")
    assert first == "[앱스토어] 👀 누군가 앱을 쓰기 시작했어요"
    assert second.startswith("📜 PLAY 상세를 열었어요 · ") and "복원" in second


def test_same_thing_in_one_visit_is_sent_once(sent):
    for i in range(3):
        visit_notify.observe("GET", f"/plays/{PLAY_ID}", "", now=T0 + i * 60)
    visit_notify.observe("GET", "/plays", "", now=T0 + 300)  # 목록은 알릴 일이 아니다
    assert len(sent) == 1


def test_quiet_gap_starts_a_new_visit(sent):
    visit_notify.observe("GET", "/plays", "", now=T0)
    visit_notify.observe("GET", "/plays", "", now=T0 + 29 * 60)
    visit_notify.observe("GET", "/plays", "", now=T0 + 29 * 60 + visit_notify.QUIET_GAP_SEC)
    assert sent == ["[앱스토어] 👀 누군가 앱을 쓰기 시작했어요"] * 2


def test_place_detail_names_the_place(sent):
    visit_notify.observe("GET", "/place/detail", "name=%EC%84%B1%EC%9D%8D%EB%AF%BC%EC%86%8D%EB%A7%88%EC%9D%84&lat=33.3&lng=126.8", now=T0)
    assert sent[0].endswith("🏛️ 장소 상세를 열었어요 · 성읍민속마을")


def test_voice_lines_trace_play_progress(sent):
    points = list(visit_notify._play_info()[PLAY_ID][1])
    lines = [f"point:{points[0]}", f"point:{points[1]}", f"point:{points[1]}", "final", "clear"]
    for i, line in enumerate(lines):
        visit_notify.observe("GET", "/tts/line", f"play_id={PLAY_ID}&line={line}", now=T0 + i)
    text = "\n".join(sent)
    assert text.count("🎧 PLAY를 시작했어요") == 1
    assert text.count(f"📍 지점 2/{len(points)} 도착쯤") == 1
    assert text.count("🏁 FINAL 단계까지 왔어요") == 1  # final·clear 둘 다 와도 한 번


def test_non_app_requests_are_not_visits(sent):
    for path in ("/health", "/privacy", "/support", "/wp-login.php"):
        visit_notify.observe("GET", path, "", now=T0)
    assert sent == []


def test_unknown_play_is_ignored_but_still_a_visit(sent):
    visit_notify.observe("GET", "/plays/no-such-play", "", now=T0)
    assert sent == ["[앱스토어] 👀 누군가 앱을 쓰기 시작했어요"]


def test_app_request_succeeds_even_if_telegram_fails(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")
    monkeypatch.setattr(visit_notify, "_last_request_at", None)

    def boom(*a, **k):
        raise ConnectionError("down")
    monkeypatch.setattr(admin_notify.requests, "post", boom)
    assert client.get("/plays").status_code == 200


def test_send_is_a_no_op_without_env(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    called = []
    monkeypatch.setattr(admin_notify.requests, "post", lambda *a, **k: called.append(1))
    assert admin_notify.send_admin_message("x") is False
    assert called == []


def test_send_never_raises_on_network_error(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")

    def boom(*a, **k):
        raise ConnectionError("https://api.telegram.org/bott/sendMessage")
    monkeypatch.setattr(admin_notify.requests, "post", boom)
    assert admin_notify.send_admin_message("x") is False


def test_hourly_cap_drops_and_reports(monkeypatch):
    """무슨 일이 있어도 운영자 폰이 알림으로 뒤덮이지 않는다."""
    out: list[str] = []
    monkeypatch.setattr(admin_notify, "send_admin_message", lambda t: out.append(t) or True)
    monkeypatch.setattr(admin_notify, "_sent_at", collections.deque())
    monkeypatch.setattr(admin_notify, "_dropped", 0)

    for i in range(admin_notify.HOURLY_CAP + 5):
        admin_notify.send_capped(f"m{i}", now=1000.0 + i)
    assert len(out) == admin_notify.HOURLY_CAP

    admin_notify.send_capped("later", now=1000.0 + 3600 + 1)
    assert out[-1] == "later\n(한 시간 상한을 넘어 알림 5건을 건너뛰었어요)"


def test_every_message_says_which_app(sent, monkeypatch):
    """같은 방문 안에서 이어지는 알림에도 어느 앱인지 붙는다 — 두 서버가 같은 봇으로 보낸다."""
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "apps-in-toss")
    visit_notify.observe("GET", "/plays", "", now=T0)
    visit_notify.observe("GET", f"/plays/{PLAY_ID}", "", now=T0 + 60)
    assert len(sent) == 2 and all(m.startswith("[토스] ") for m in sent)
