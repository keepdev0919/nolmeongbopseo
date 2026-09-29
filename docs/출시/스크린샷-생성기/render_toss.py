"""toss.html 을 토스 미니앱(앱인토스) 등록 규격 PNG 로 찍는다.

    .venv/bin/python3 docs/출시/스크린샷-생성기/render_toss.py

결과: docs/출시/토스_등록이미지/ — 세로 스크린샷 636×1048 6장, 가로 썸네일 1932×828, 로고 600×600.
콘솔은 해상도가 1px 이라도 다르면 거부하므로 찍은 뒤 크기를 확인한다.
"""

import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

from render import serve

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "토스_등록이미지"
ICON = HERE.parents[2] / "ios/JejuFolklore/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    Image.open(ICON).convert("RGB").resize((600, 600), Image.LANCZOS).save(OUT / "logo.png")
    print("logo", (600, 600))

    port = serve()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1932, "height": 1048}, device_scale_factor=1)
        page.goto(f"http://127.0.0.1:{port}/toss.html?export&w=636&h=1048")
        page.evaluate("document.fonts.ready")
        page.wait_for_function("[...document.images].every(i => i.complete && i.naturalWidth > 0)")
        for el in page.query_selector_all(".slide"):
            slide_id = el.get_attribute("data-id")
            im = Image.open(io.BytesIO(el.screenshot(type="png"))).convert("RGB")
            want = (1932, 828) if slide_id == "thumbnail" else (636, 1048)
            assert im.size == want, (slide_id, im.size)
            im.save(OUT / ("thumbnail.png" if slide_id == "thumbnail" else f"screenshot-{slide_id}.png"))
            print(slide_id, im.size)
        browser.close()


if __name__ == "__main__":
    main()
