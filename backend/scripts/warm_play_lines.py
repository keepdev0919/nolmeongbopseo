"""PLAY 의 곱딱이 대사를 **미리** 음성으로 만들어 캐시에 넣는다.

왜: 처음 듣는 문장은 Typecast 가 만드는 데 3초쯤 걸려 글자보다 소리가 늦다
(2026-09-11 조익준님 지적). 배포 전에 한 번 돌려 두면 사용자는 전부 캐시로 듣는다.
같은 문장은 두 번 만들지 않으므로(내용 해시 키) 여러 번 돌려도 비용이 늘지 않는다.

    cd backend && ../.venv/bin/python3 scripts/warm_play_lines.py            # 모든 PLAY
    cd backend && ../.venv/bin/python3 scripts/warm_play_lines.py seongeup-restore
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from routers.tts import resolve_line  # noqa: E402
from services import place_registry, play_loader, typecast  # noqa: E402
from services.db import get_db_connection  # noqa: E402


def line_keys(play) -> list[str]:
    keys: list[str] = []
    for pt in play.points:
        keys.append(f"point:{pt.id}")
        for m in pt.missions:
            for i, st in enumerate(m.steps):
                keys.append(f"mission:{m.id}:{i}")
                if st.success_feedback:
                    keys.append(f"feedback:{m.id}:{i}")
            if m.discovery and m.discovery.body:
                keys.append(f"discovery:{m.id}")
    keys += [f"story:{s.id}" for s in play.stories]
    if play.final:
        keys.append("final")
    if play.clear and play.clear.body:
        keys.append("clear")
    return keys


def main(only: str | None) -> None:
    conn = get_db_connection()
    place_registry.ensure_synced(conn)
    plays = [p for p in play_loader.load_all(conn) if only is None or p.id == only]
    if not plays:
        sys.exit(f"PLAY 를 찾지 못했습니다: {only}")
    made = hit = chars = 0
    for play in plays:
        print(f"== {play.id} ({play.title})")
        for key in line_keys(play):
            try:
                text = resolve_line(play, key)
            except ValueError as e:
                print(f"   건너뜀 {key}: {e}")
                continue
            _, from_cache = typecast.synth(text, emotion="normal", lang="kor", conn=conn)
            hit += from_cache
            made += not from_cache
            chars += 0 if from_cache else len(text)
            print(f"   {'캐시' if from_cache else '생성'} {key:28} {len(text):4}자")
    print(f"\n새로 만든 것 {made}줄 {chars:,}자 · 이미 있던 것 {hit}줄")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
