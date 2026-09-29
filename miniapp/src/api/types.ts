/**
 * 서버 응답 타입 — ios/JejuFolklore/Sources/Models/*.swift 이식.
 *
 * 서버(FastAPI, backend/models/play.py · models/schemas.py)는 **snake_case** 로 준다.
 * Swift 가 `convertFromSnakeCase` 로 받듯이 `client.ts` 가 응답 키를 전부 camelCase 로 바꾼다.
 * 그래서 여기 타입은 전부 camelCase 다 (`place_key` → `placeKey`, `bus_stops` → `busStops`).
 *
 * 화면이 쓰는 파생값(「60~75분」, 정답 판정 등)은 `models.ts` 에 함수로 있다.
 */

// ═══════════════════════════════ PLAY ═══════════════════════════════

/** Step 의 입력 방식. 화면을 정하는 것은 이것 하나뿐이다. */
export type MissionInput = 'CONFIRM' | 'CHOICE' | 'DIRECTION' | 'NUMBER' | 'SHORT_TEXT' | 'MATCH_ORDER';

/**
 * Step 의 정답 / 사용자가 넣은 답. Swift `MissionAnswer` 의 네 모양을 JSON 그대로 둔다.
 *
 *   null      CONFIRM — 누르면 통과                     (Swift .none)
 *   string    CHOICE(보기 id) · DIRECTION(LEFT/RIGHT/UP/DOWN)   (.text)
 *   number    NUMBER                                    (.number)
 *   string[]  SHORT_TEXT(허용 답안) · MATCH_ORDER(순서 또는 "a>x")  (.list)
 */
export type MissionAnswer = null | string | number | string[];

export interface MissionOption {
  id: string;
  label: string;
  /** 그림 보기. ⚠️ 미션의 답이 되는 현실물을 그림으로 대체하지 않는다. */
  image: string | null;
}

export interface MissionStep {
  inputType: MissionInput;
  prompt: string;
  options: MissionOption[];
  /** 짝 맞추기의 오른쪽 항목. 비어 있으면 MATCH_ORDER 는 '순서 세우기'다. */
  matchTargets: MissionOption[];
  answer: MissionAnswer;
  successFeedback: string;
  failureFeedback: string;
}

export interface MissionHint {
  text: string;
}

export interface MissionDiscovery {
  title: string;
  body: string;
}

export type MissionVerification = 'strong' | 'likely' | 'unverified';

export interface Mission {
  id: string;
  title: string;
  patterns: string[];
  prompt: string;
  steps: MissionStep[];
  hints: MissionHint[];
  discovery: MissionDiscovery | null;
  /** 채워지는 진행도 칸 id. 없을 수 있다. */
  progressReward: string | null;
  verification: MissionVerification;
  isShowcase: boolean;
}

export interface PlayPoint {
  id: string;
  title: string;
  objective: string;
  lat: number | null;
  lng: number | null;
  navigationText: string;
  intro: string;
  missions: Mission[];
}

export interface StorySource {
  kind: string;
  ref: string;
  note: string;
}

/** 발견의 의미. `script` 하나가 화면 자막이자 TTS 원문이다. */
export interface PlayStory {
  id: string;
  title: string;
  script: string;
  sources: StorySource[];
  unlockAfterMission: string;
}

export interface FinalStage {
  id: string;
  title: string;
  prompt: string;
  step: MissionStep;
  // FINAL 뒤에 이야기를 끼우지 않는다 (2026-09-29 결정) — FINAL 을 맞히면 바로 CLEAR.
  // 마무리 글은 `clear.body` 한 곳이 맡는다. 서버 원고도 이 칸을 받지 않는다.
  hints: MissionHint[];
}

export interface ClearStage {
  title: string;
  body: string;
}

/** 이번 PLAY 에서 모으는 것 한 칸 (성읍은 「생활기록 6칸」). */
export interface ProgressRecord {
  id: string;
  label: string;
}

export type RouteRevealMode = 'FULL' | 'PROGRESSIVE';

export type Difficulty = '쉬움' | '보통' | '어려움';

/** `GET /plays/{id}` — PLAY 하나 전체. */
export interface Play {
  id: string;
  /** 놀멍봅서가 발급한 불변 Place ID. */
  placeId: string;
  /** 픽셀 커버 파일 이름이기도 하다 → `coverFor(placeKey)` */
  placeKey: string;
  placeName: string;

  title: string;
  objective: string;
  cardSummary: string;

  estimatedMinutesMin: number;
  estimatedMinutesMax: number;
  distanceMeters: number;
  difficulty: Difficulty | string;
  /** 난이도 별 (0~5) */
  difficultyStars: number;

  progressLabel: string;
  progressRecords: ProgressRecord[];

  routeRevealMode: RouteRevealMode;
  startName: string;
  startLat: number | null;
  startLng: number | null;
  finishName: string;

  points: PlayPoint[];
  stories: PlayStory[];
  final: FinalStage | null;
  clear: ClearStage | null;
}

/** 홈 카드·지도 핀·장소 상세가 쓰는 가벼운 형태 (`GET /plays` 의 plays[]). */
export interface PlaySummary {
  id: string;
  placeId: string;
  placeKey: string;
  placeName: string;
  title: string;
  objective: string;
  /** 카드용 두 줄 요약. 비어 있으면 objective 를 쓴다 → `playCardText()` */
  cardSummary: string;
  estimatedMinutesMin: number;
  estimatedMinutesMax: number;
  distanceMeters: number;
  difficulty: Difficulty | string;
  difficultyStars: number;
  missionCount: number;
  /** KTO 대표사진 URL (https) */
  thumbnail: string | null;
}

export type PlayMapPinStatus = 'active' | 'preparing';

/** `GET /map/pins` 의 pins[]. id 는 placeId 다. */
export interface PlayMapPin {
  placeId: string;
  placeKey: string;
  placeName: string;
  lat: number;
  lng: number;
  status: PlayMapPinStatus;
  thumbnail: string | null;
  play: PlaySummary | null;
  /** 지도에는 다 뜨지만 홈 「수행 가능한 퀘스트」에는 일부만 노출한다. */
  homeVisible: boolean;
}

/** `PlayAPI.mapPins()` 결과. 개수는 **서버가 센 값** 그대로 쓴다. */
export interface MapPins {
  pins: PlayMapPin[];
  activeCount: number;
  preparingCount: number;
}

// ═══════════════════════════════ 코스 ═══════════════════════════════

export interface CoursePlace {
  name: string;
  lat: number;
  lng: number;
  day: number;
  startTime: string | null;
}

/** `POST /course/detail` — 코스 하나. ⚠️ `id` 는 요청마다 새로 만드는 UUID 다. 진짜 신원은 `sourceCourseId`. */
export interface Course {
  id: string;
  title: string;
  durationDays: number;
  places: CoursePlace[];
  estimatedMinutes: number;
  /** 목록 항목의 id 와 같다 (= `/course/detail` 에 보낸 course_id). */
  sourceCourseId: string;
}

/** `POST /course/list` · `GET /course/featured` 의 항목. */
export interface CourseListItem {
  id: string;
  title: string;
  durationDays: number;
  /** 동부 | 서부 | 남부 | 북부 | 전체. 없으면 「전체」로 다룬다 → `courseListItemRegion()` */
  region: string | null;
  /** 대표 장소의 KTO 대표사진. 없으면 권역색 픽셀 블록. */
  thumbnail: string | null;
  places: CoursePlace[];
}

// ═══════════════════════════════ 장소 ═══════════════════════════════

export interface PlaceInfoRow {
  label: string;
  value: string;
}

/** `GET /place/detail` — KTO OpenAPI 관광정보. 빈 칸은 "" / [] 로 채워서 준다. */
export interface PlaceDetail {
  name: string;
  overview: string;
  images: string[];
  address: string;
  tel: string;
  openTime: string;
  restDate: string;
  useFee: string;
  parking: string;
  /** 반복정보 — 화장실·주차요금·해설 안내 (KTO detailInfo2) */
  info: PlaceInfoRow[];
  /** 무장애 여행정보 (KTO KorWithService2) */
  accessibility: PlaceInfoRow[];
}

export interface NearbyFacility {
  name: string;
  distanceM: number;
  lat: number;
  lng: number;
  /** 화장실만. 정류장은 null. */
  openTime: string | null;
  /** 화장실만 — 장애인용 변기가 있는가. */
  accessible: boolean | null;
}

/** `GET /place/nearby` — 관광지 좌표 주변 1km 공중화장실·버스정류장. */
export interface PlaceNearby {
  toilets: NearbyFacility[];
  busStops: NearbyFacility[];
}

// ═══════════════════════════════ 신고 ═══════════════════════════════

/** 미션 신고 사유. 서버 ALLOWED_REASONS 와 같아야 한다. */
export type MissionReportReason = 'notVisible' | 'blocked' | 'mismatch' | 'other';
