/**
 * PLAY 진행 저장 — Models/PlayProgress.swift + Services/PlayProgressStore.swift 이식.
 *
 * ## 왜 저장하나 (2026-09-07 되살림)
 * 성읍은 60~75분짜리다. 현장에서 전화가 오거나 배터리를 아끼려 앱을 내리면 처음부터
 * 다시 해야 했다. 여러 PLAY 를 동시에 붙잡고 있을 수 있다 — 하다 말고 다른 곳에 갔다가
 * 돌아올 수 있어야 한다.
 *
 * ## 미션 단위로 저장한다
 * 러너가 **미션을 하나 끝낼 때마다** `save()` 한다. 나갔다 들어오면 **마지막으로 완료한
 * 미션 다음**부터 시작하고, 진행 중이던 미션의 Step·힌트는 되살아나지 않는다.
 * (나가기 확인창 문구: 「나가기 (완료한 지점까지 저장돼요)」)
 * 단, 끝낸 미션의 발견·이야기를 보던 중이었으면 그 자리부터 다시 연다 — `pendingReveal`.
 *
 * ## 다른 곳이 읽는 것
 *   홈 카드      inProgress() → 「이어서 하기」, completed() → 「다시 하기」
 *   PLAY 상세    load(playId) → 버튼 문구, clear(playId) → 「처음부터 다시 하기」
 *   러너         beginPlay() 로 시작/이어받기, 미션 완료·CLEAR 때 save()
 *
 * 저장 키는 iOS 와 같은 `play_progress_v1`. 값은 `{ [playId]: PlayProgress }` JSON.
 * 시각은 epoch **밀리초**(number)로 둔다.
 */
import { orderedMissions } from '../api/models';
import type { Play } from '../api/types';
import { createJsonStore, type JsonStore } from './jsonStore';
import type { KeyValueBackend } from './kv';

export const PLAY_PROGRESS_KEY = 'play_progress_v1';

/**
 * 미션은 끝냈지만 **아직 다 못 본** 발견·이야기 (2026-09-15).
 *
 * 진행은 미션을 끝내는 순간 저장된다. 그 뒤에 나오는 발견·이야기를 보다가 앱을 내리면
 * 예전에는 이어서 할 때 그걸 건너뛰고 다음 미션으로 갔다 — 방금 찾은 것의 의미를 못 듣고
 * 지나가는 셈이다. 그래서 무엇을 보던 중이었는지 같이 적어 두고, 이어서 할 때 거기부터 연다.
 */
export type PendingReveal = { after: 'mission'; missionId: string; stage: 'discovery' | 'story' };

/** 이번 판의 상태. */
export interface PlayProgress {
  playId: string;
  currentPointId: string;
  currentMissionId: string;
  currentStepIndex: number;
  completedMissionIds: string[];
  /** 복원한 기록 칸. 「생활기록 4/6」의 4. */
  discoveredRecordIds: string[];
  /** 건너뛴 미션. 진행은 되지만 **직접 발견한 것은 아니다** — CLEAR 에서 구분해 보여준다. */
  skippedMissionIds: string[];
  finalCleared: boolean;
  /** 아직 다 못 본 발견·이야기. 없으면 null. 이 필드가 생기기 전 저장값에는 없다(= null 로 읽는다). */
  pendingReveal?: PendingReveal | null;
  /** epoch ms */
  startedAt: number;
  /** epoch ms. save() 가 채운다. */
  updatedAt: number;
}

export type ProgressMap = Record<string, PlayProgress>;

/** 새 판. 첫 미션에서 시작한다. */
export function createPlayProgress(play: Play, now: number = Date.now()): PlayProgress {
  const first = orderedMissions(play)[0];
  return {
    playId: play.id,
    currentPointId: first?.point.id ?? '',
    currentMissionId: first?.mission.id ?? '',
    currentStepIndex: 0,
    completedMissionIds: [],
    discoveredRecordIds: [],
    skippedMissionIds: [],
    finalCleared: false,
    pendingReveal: null,
    startedAt: now,
    updatedAt: now,
  };
}

export const isFinished = (p: PlayProgress): boolean => p.finalCleared;

/**
 * 이어받을 미션 번호 (orderedMissions 기준).
 * **완료하지 않은 첫 미션**. 전부 완료했으면 마지막 미션(→ 러너가 FINAL 로 넘긴다).
 */
export function resumeMissionIndex(play: Play, saved: PlayProgress): number {
  const flat = orderedMissions(play);
  const i = flat.findIndex(({ mission }) => !saved.completedMissionIds.includes(mission.id));
  return i >= 0 ? i : Math.max(flat.length - 1, 0);
}

/**
 * 러너가 시작할 때 부른다 (RunnerViewModel.init).
 * - 저장된 진행이 있고 **CLEAR 전**이면 이어받는다 (완료한 미션 다음부터).
 * - 이미 CLEAR 한 기록은 이어받지 않는다 — 「다시 하기」는 처음부터가 맞다.
 */
export function beginPlay(
  play: Play,
  saved: PlayProgress | null,
  now: number = Date.now(),
): { progress: PlayProgress; missionIndex: number; resumed: boolean } {
  if (saved && !isFinished(saved)) {
    return { progress: saved, missionIndex: resumeMissionIndex(play, saved), resumed: true };
  }
  return { progress: createPlayProgress(play, now), missionIndex: 0, resumed: false };
}

/** 진행 지도에 체크를 넣을 Point — 그 Point 의 미션을 **전부** 끝냈을 때. */
export function clearedPointIds(play: Play, progress: PlayProgress): Set<string> {
  return new Set(
    play.points
      .filter((pt) => pt.missions.length > 0 && pt.missions.every((m) => progress.completedMissionIds.includes(m.id)))
      .map((pt) => pt.id),
  );
}

/** 홈 카드·PLAY 상세 버튼 문구. 저장이 없으면 null(→ 「퀘스트 수락」/「플레이하기」는 화면이 정한다). */
export function progressLabel(p: PlayProgress | null | undefined): '이어서 하기' | '다시 하기' | null {
  if (!p) return null;
  return isFinished(p) ? '다시 하기' : '이어서 하기';
}

// ── 저장 형식 검사 ─────────────────────────────────────────────────────

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function isPlayProgress(v: unknown): v is PlayProgress {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.playId === 'string' &&
    typeof p.currentPointId === 'string' &&
    typeof p.currentMissionId === 'string' &&
    typeof p.currentStepIndex === 'number' &&
    isStrArr(p.completedMissionIds) &&
    isStrArr(p.discoveredRecordIds) &&
    isStrArr(p.skippedMissionIds) &&
    typeof p.finalCleared === 'boolean' &&
    typeof p.startedAt === 'number' &&
    typeof p.updatedAt === 'number'
  );
}

/**
 * 못 읽는 pendingReveal 은 null 로 본다. 이것 때문에 진행 전체를 버리지는 않는다 —
 * 없어도 「완료한 미션 다음부터」로 이어갈 수 있다.
 */
function readPendingReveal(v: unknown): PendingReveal | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  // `{ after: 'final' }`(FINAL 뒤 이야기, 2026-09-29 칸째 없앰)도 여기서 null 이 된다 —
  // 미션을 다 끝낸 저장값이라 FINAL 부터 다시 연다.
  if (r.after === 'mission' && typeof r.missionId === 'string' && (r.stage === 'discovery' || r.stage === 'story')) {
    return { after: 'mission', missionId: r.missionId, stage: r.stage };
  }
  return null;
}

/** 하나라도 못 읽으면 통째로 버린다 — iOS 가 `[String: PlayProgress]` 디코딩 실패 때 그러듯이. */
function parseProgressMap(raw: unknown): ProgressMap | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: ProgressMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isPlayProgress(v)) return null;
    out[k] = { ...v, pendingReveal: readPendingReveal((v as unknown as Record<string, unknown>).pendingReveal) };
  }
  return out;
}

// ── 저장소 ─────────────────────────────────────────────────────────────

export interface PlayProgressStore {
  readonly raw: JsonStore<ProgressMap>;
  hydrate(): Promise<void>;
  load(playId: string): PlayProgress | null;
  /** updatedAt 을 지금으로 찍어 저장하고, 저장된 값을 돌려준다. */
  save(progress: PlayProgress): PlayProgress;
  clear(playId: string): void;
  /** 진행 중(아직 CLEAR 안 한 것), 최근 것부터. */
  inProgress(): PlayProgress[];
  /** 완료한 것, 최근 것부터. */
  completed(): PlayProgress[];
  all(): ProgressMap;
  subscribe(listener: () => void): () => void;
  whenIdle(): Promise<void>;
}

export function createPlayProgressStore(
  backend: KeyValueBackend,
  opts: { now?: () => number } = {},
): PlayProgressStore {
  const now = opts.now ?? Date.now;
  const raw = createJsonStore<ProgressMap>({ backend, key: PLAY_PROGRESS_KEY, empty: () => ({}), parse: parseProgressMap });
  const byRecent = (a: PlayProgress, b: PlayProgress) => b.updatedAt - a.updatedAt;
  const persist = (next: ProgressMap) => {
    raw.set(next).catch(() => undefined); // 실패는 jsonStore 가 로그로 남긴다. 메모리 값은 유지.
  };

  return {
    raw,
    hydrate: () => raw.hydrate(),
    load: (playId) => raw.get()[playId] ?? null,
    save(progress) {
      const saved: PlayProgress = { ...progress, updatedAt: now() };
      persist({ ...raw.get(), [saved.playId]: saved });
      return saved;
    },
    clear(playId) {
      if (!(playId in raw.get())) return;
      const next = { ...raw.get() };
      delete next[playId];
      persist(next);
    },
    inProgress: () => Object.values(raw.get()).filter((p) => !isFinished(p)).sort(byRecent),
    completed: () => Object.values(raw.get()).filter(isFinished).sort(byRecent),
    all: () => raw.get(),
    subscribe: (l) => raw.subscribe(l),
    whenIdle: () => raw.whenIdle(),
  };
}
