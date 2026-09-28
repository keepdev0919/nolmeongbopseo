"""스토어에 공개되는 법적 고지·지원 페이지를 지킨다.

앱스토어는 개인정보 처리방침 URL 과 지원 URL 을 필수로 요구하고, 처리방침에 연락처가
비어 있으면 심사에서 걸린다. 한때 처리방침 이메일 칸이 「__________」 빈칸이었다.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def test_privacy_and_support_pages_are_served_with_a_real_contact():
    for path in ("/privacy", "/support"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert "keepdev0919@gmail.com" in r.text, f"{path} 에 문의 이메일이 없다"
        assert "____" not in r.text, f"{path} 에 빈칸이 남아 있다"


def test_privacy_lists_every_external_service_the_server_calls():
    """서버가 실제로 부르는 외부 서비스는 처리방침 §5 에 있어야 한다."""
    text = client.get("/privacy").text
    for name in ("한국관광공사", "Typecast", "Google Maps", "공중화장실", "버스정류소"):
        assert name in text, name
