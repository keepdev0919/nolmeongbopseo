/**
 * 엔드포인트 — Services/PlayAPI.swift · CourseAPI.swift · PlaceAPI.swift ·
 * MissionReportSheet.swift(신고) · StoryAudioPlayer.swift(TTS 주소) 이식.
 *
 * 모든 함수는 마지막 인자로 `{ signal }` 을 받는다 — 화면이 사라질 때 끊으려면 넘긴다.
 */
import { apiGet, apiPost, type RequestOptions } from './client';
import { API_BASE } from './config';
import type {
  Course,
  CourseListItem,
  MapPins,
  MissionReportReason,
  NearbyFacility,
  PlaceDetail,
  PlaceInfoRow,
  PlaceNearby,
  Play,
  PlayMapPin,
  PlaySummary,
} from './types';

// ═══════════════════════════════ PLAY ═══════════════════════════════

/**
 * PLAY · Place 조회.
 * ⚠️ 사용자 위치를 보내지 않는다. 거리 계산은 전부 단말에서 한다 (`lib/geo.ts`).
 */
export const PlayAPI = {
  /** 플레이할 수 있는 PLAY 전부. `GET /plays` */
  async list(opts?: RequestOptions): Promise<PlaySummary[]> {
    const r = await apiGet<{ plays: PlaySummary[] }>('/plays', undefined, opts);
    return r.plays;
  },

  /** PLAY 하나 전체 — Point · Mission · Step · Story 까지. `GET /plays/{id}` (없으면 404) */
  detail(id: string, opts?: RequestOptions): Promise<Play> {
    return apiGet<Play>(`/plays/${encodeURIComponent(id)}`, undefined, opts);
  },

  /** 이 장소에서 할 수 있는 PLAY. **비어 있는 것이 정상이다.** `GET /places/{placeId}/plays` */
  async forPlace(placeId: string, opts?: RequestOptions): Promise<PlaySummary[]> {
    const r = await apiGet<{ plays: PlaySummary[] }>(`/places/${encodeURIComponent(placeId)}/plays`, undefined, opts);
    return r.plays;
  },

  /** 지도 핀 + 서버가 센 개수. `GET /map/pins` */
  async mapPins(opts?: RequestOptions): Promise<MapPins> {
    const r = await apiGet<{ pins: PlayMapPin[]; activeCount: number; preparingCount: number }>('/map/pins', undefined, opts);
    return { pins: r.pins, activeCount: r.activeCount, preparingCount: r.preparingCount };
  },
};

// ═══════════════════════════════ 코스 ═══════════════════════════════

function normalizeListItem(item: CourseListItem): CourseListItem {
  // region 은 서버가 나중에 주기 시작했다 — 없으면 null 로 두고 화면이 「전체」로 다룬다.
  return { ...item, region: item.region ?? null, thumbnail: item.thumbnail ?? null };
}

export const CourseAPI = {
  /**
   * 권역·기간으로 코스 찾기. `POST /course/list` { region, duration_days }
   * - region: 동부 | 서부 | 남부 | 북부 | 전체
   * - durationDays: 1~4. 4 는 「3박4일 이상」(4일 이상 전부). 라벨 「N박M일」이면 M 을 보낸다.
   * 조건에 맞는 코스가 없으면 404 (ApiError.status === 404).
   */
  async list(region: string, durationDays: number, opts?: RequestOptions): Promise<CourseListItem[]> {
    const r = await apiPost<CourseListItem[]>('/course/list', { region, durationDays }, opts);
    return r.map(normalizeListItem);
  },

  /** 코스 탭 첫 화면 둘러보기. **부를 때마다 다른 코스가 온다.** `GET /course/featured?limit=` */
  async featured(limit = 5, opts?: RequestOptions): Promise<CourseListItem[]> {
    const r = await apiGet<CourseListItem[]>('/course/featured', { limit }, opts);
    return r.map(normalizeListItem);
  },

  /**
   * 코스 상세. `POST /course/detail` { course_id }
   * ⚠️ 돌려받는 `id` 는 매번 새 UUID 다. 같은 코스인지는 `sourceCourseId`(= 보낸 courseId)로 본다.
   */
  async detail(courseId: string, opts?: RequestOptions): Promise<Course> {
    const c = await apiPost<Course>('/course/detail', { courseId }, opts);
    return {
      ...c,
      sourceCourseId: c.sourceCourseId ?? '',
      places: c.places.map((p) => ({ ...p, startTime: p.startTime ?? null })),
    };
  },
};

// ═══════════════════════════════ 장소 ═══════════════════════════════

function rows(v: unknown): PlaceInfoRow[] {
  return Array.isArray(v) ? (v as PlaceInfoRow[]) : [];
}

/** 서버가 옛 캐시를 돌려줘도 빈 칸 때문에 화면 전체가 깨지지 않게 한다 (Swift PlaceDetail.init(from:)). */
function normalizePlaceDetail(raw: Partial<PlaceDetail> & { name: string }): PlaceDetail {
  return {
    name: raw.name,
    overview: raw.overview ?? '',
    images: Array.isArray(raw.images) ? raw.images : [],
    address: raw.address ?? '',
    tel: raw.tel ?? '',
    openTime: raw.openTime ?? '',
    restDate: raw.restDate ?? '',
    useFee: raw.useFee ?? '',
    parking: raw.parking ?? '',
    info: rows(raw.info),
    accessibility: rows(raw.accessibility),
  };
}

function normalizeFacility(f: NearbyFacility): NearbyFacility {
  return { ...f, openTime: f.openTime ?? null, accessible: f.accessible ?? null };
}

export const PlaceAPI = {
  /**
   * KTO OpenAPI 관광정보. `GET /place/detail?name=&lat=&lng=`
   * lat/lng 는 **관광지 좌표**다 (사용자 위치 금지). KTO 에 없는 장소는 빈 칸으로 200 이 온다.
   */
  async detail(name: string, lat: number, lng: number, opts?: RequestOptions): Promise<PlaceDetail> {
    const r = await apiGet<Partial<PlaceDetail> & { name: string }>('/place/detail', { name, lat: String(lat), lng: String(lng) }, opts);
    return normalizePlaceDetail(r);
  },

  /** 관광지 좌표 주변 1km 화장실·정류장. `GET /place/nearby?lat=&lng=` ⚠️ 관광지 좌표만. */
  async nearby(lat: number, lng: number, opts?: RequestOptions): Promise<PlaceNearby> {
    const r = await apiGet<PlaceNearby>('/place/nearby', { lat: String(lat), lng: String(lng) }, opts);
    return {
      toilets: (r.toilets ?? []).map(normalizeFacility),
      busStops: (r.busStops ?? []).map(normalizeFacility),
    };
  },
};

// ═══════════════════════════════ 신고 ═══════════════════════════════

export const ReportAPI = {
  /**
   * 미션 신고 — 「현장에서 찾을 수 없어요」. `POST /report/mission` → 201 { id }
   * ⚠️ 기기 ID·위치·사진을 보내지 않는다 (신고 화면이 그렇게 약속한다). note 는 500자 이내.
   * 못 보낸 신고를 쌓아 두었다가 다시 보내려면 `stores/missionReports.ts` 를 쓴다.
   */
  mission(
    body: { playId: string; missionId: string; reason: MissionReportReason; note: string },
    opts?: RequestOptions,
  ): Promise<{ id: string }> {
    return apiPost<{ id: string }>('/report/mission', body, opts);
  },
};

// ═══════════════════════════════ 음성 (TTS) ═══════════════════════════════

/**
 * 곱딱이 대사 한 줄의 음성 주소 (mp3). `<audio src>` 에 그대로 넣는다.
 * 문장을 보내지 않는다 — PLAY id 와 대사 열쇠만 보낸다. 열쇠 형식(backend/routers/tts.py `resolve_line`):
 *
 *   point:<pointId>              안내 — navigationText, 없으면 objective
 *   mission:<missionId>:<step>   미션 — 첫 Step 은 mission.prompt + 빈 줄 + step.prompt
 *   feedback:<missionId>:<step>  정답 뒤 한마디 — step.successFeedback
 *   discovery:<missionId>        발견 — mission.discovery.body
 *   story:<storyId>              이야기 — story.script
 *   final                        마지막 과제 — final.prompt
 *   clear                        완주 — clear.body
 */
export function ttsLineUrl(playId: string, line: string): string {
  const u = new URL(`${API_BASE}/tts/line`);
  u.searchParams.set('play_id', playId);
  u.searchParams.set('line', line);
  return u.toString();
}
