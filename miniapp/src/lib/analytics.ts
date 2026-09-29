/**
 * 토스 분석으로 보내는 이벤트 — 앱인토스 콘솔 「핵심 지표」의 재료 (2026-09-29).
 *
 * 화면 이동은 토스가 알아서 기록한다(`/course::screen` 등). 여기 있는 것은 **주소가 바뀌지 않아
 * 자동으로 안 잡히는 순간**뿐이다.
 *
 *   play_start   PLAY 를 처음부터 시작 (「이어서 하기」는 세지 않는다) — 활성·보조 전환
 *   play_clear   PLAY CLEAR — 대표 전환
 *   course_save  코스 담기 — 보조 전환
 *
 * ⚠️ 이 이름들은 콘솔 지표 설정이 가리킨다. **바꾸면 지표가 끊긴다.**
 * 토스 분석으로만 가고 우리 서버로는 아무것도 보내지 않는다. 기기 ID·위치는 싣지 않는다.
 * 분석은 부가 기능이라 실패해도 조용히 넘어간다.
 */
import { Analytics } from '@apps-in-toss/web-framework';

export type AnalyticsEvent = 'play_start' | 'play_clear' | 'course_save';

export function logEvent(name: AnalyticsEvent, params: Record<string, string | number | boolean> = {}): void {
  try {
    void Analytics.log({ log_name: name, log_type: 'event', params }).catch(() => undefined);
  } catch {
    /* 토스 밖(일반 브라우저) — 넘어간다 */
  }
}
