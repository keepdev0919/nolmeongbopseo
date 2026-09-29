"""iOS 테스트가 쓰는 성읍 PLAY 사본이 지금 서버가 내려주는 것과 같은지 본다.

iOS 테스트(`ios/JejuFolkloreTests/PlayRunnerClearTests.swift`)는 이 사본으로
「성읍을 처음부터 끝까지 풀면 CLEAR 에 닿는다」를 확인한다. 사본이 원고와
어긋나면 그 테스트는 이미 없는 PLAY 를 검사하게 된다.

원고를 고친 뒤 사본을 새로 만들려면:

    UPDATE_IOS_FIXTURE=1 .venv/bin/python3 -m pytest tests/test_ios_play_fixture.py
"""
import json
import os
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent.parent / "ios/JejuFolkloreTests/Fixtures/seongeup.json"


def test_iOS_테스트용_성읍_사본이_서버_응답과_같다(client):
    res = client.get("/plays/seongeup-restore")
    assert res.status_code == 200
    served = res.json()
    if os.environ.get("UPDATE_IOS_FIXTURE"):
        FIXTURE.write_text(json.dumps(served, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == served, \
        "원고가 바뀌었습니다 — 위 docstring 의 명령으로 iOS 테스트용 사본을 새로 만드세요"
