"""운영자 텔레그램 알림 — 앱 첫 실행 · PLAY 시작 · CLEAR.

지키는 것:
1. 알림이 실패하거나 꺼져 있어도 앱 요청은 성공한다 (알림은 부가 기능).
2. 모르는 PLAY·모르는 값은 막는다 — 운영자 텔레그램에 아무 글자나 흘려보내는 통로가 되면 안 된다.
3. 식별자를 받지 않는다 — 처리방침 §4 의 약속.
"""
import pytest

import routers.event as event_router
from services import admin_notify

PLAY_ID = "seongeup-restore"


@pytest.fixture
def sent(monkeypatch):
    """텔레그램 대신 보낸 글을 모은다."""
    box: list[str] = []
    monkeypatch.setattr(event_router, "send_capped", lambda text: box.append(text) or True)
    return box


def test_first_open_notifies_with_platform(client, sent):
    res = client.post("/event", json={"type": "first_open", "platform": "ios"})
    assert res.status_code == 202, res.text
    assert sent == ["📲 새 기기에서 처음 실행 · 앱스토어"]


def test_play_start_uses_play_title(client, sent):
    res = client.post("/event", json={"type": "play_start", "platform": "toss", "play_id": PLAY_ID})
    assert res.status_code == 202, res.text
    assert sent[0].startswith("▶️ PLAY 시작 · 토스\n")
    assert "복원" in sent[0]  # 「성읍 생활기록 복원작전」 — id 가 아니라 사람이 읽는 제목


def test_play_clear_carries_minutes_and_skips(client, sent):
    res = client.post("/event", json={
        "type": "play_clear", "platform": "ios", "play_id": PLAY_ID, "minutes": 52, "skipped": 1})
    assert res.status_code == 202, res.text
    assert sent[0].startswith("🏆 CLEAR · 앱스토어\n")
    assert sent[0].endswith(" · 52분 · 건너뛴 미션 1")


@pytest.mark.parametrize("body", [
    {"type": "play_start", "platform": "ios", "play_id": "no-such-play"},
    {"type": "play_start", "platform": "ios"},
    {"type": "signup", "platform": "ios"},
    {"type": "first_open", "platform": "android"},
])
def test_rejects_unknown_values_without_notifying(client, sent, body):
    assert client.post("/event", json=body).status_code in (400, 422)
    assert sent == []


def test_does_not_accept_identifiers(client, sent):
    """기기 ID 를 같이 보내도 서버 모델에 자리가 없어 버려진다."""
    client.post("/event", json={"type": "first_open", "platform": "ios", "device_id": "ABC-123"})
    assert "ABC-123" not in sent[0]
    assert set(event_router.AppEvent.model_fields) == {"type", "platform", "play_id", "minutes", "skipped"}


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


def test_app_request_succeeds_even_if_telegram_fails(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")

    def boom(*a, **k):
        raise ConnectionError("down")
    monkeypatch.setattr(admin_notify.requests, "post", boom)
    res = client.post("/event", json={"type": "first_open", "platform": "toss"})
    assert res.status_code == 202


@pytest.mark.parametrize("minutes, expected", [
    (3000, "하루 이상 (이어서 한 판)"),  # 어제 시작해 오늘 이어서 CLEAR
    (-5, None),                          # 기기 시계를 돌렸다
])
def test_odd_minutes_still_notify(client, sent, minutes, expected):
    """앱은 실패한 알림을 다시 보내지 않는다 — 막으면 그 CLEAR 알림이 사라진다."""
    res = client.post("/event", json={
        "type": "play_clear", "platform": "ios", "play_id": PLAY_ID, "minutes": minutes})
    assert res.status_code == 202, res.text
    if expected:
        assert expected in sent[0]
    assert "-5" not in sent[0]


def test_hourly_cap_drops_and_reports(monkeypatch):
    """누가 엔드포인트를 두드려도 운영자 폰이 뒤덮이지 않는다."""
    import collections
    out: list[str] = []
    monkeypatch.setattr(admin_notify, "send_admin_message", lambda t: out.append(t) or True)
    monkeypatch.setattr(admin_notify, "_sent_at", collections.deque())
    monkeypatch.setattr(admin_notify, "_dropped", 0)

    for i in range(admin_notify.HOURLY_CAP + 5):
        admin_notify.send_capped(f"m{i}", now=1000.0 + i)
    assert len(out) == admin_notify.HOURLY_CAP

    admin_notify.send_capped("later", now=1000.0 + 3600 + 1)
    assert out[-1] == "later\n(한 시간 상한을 넘어 알림 5건을 건너뛰었어요)"
