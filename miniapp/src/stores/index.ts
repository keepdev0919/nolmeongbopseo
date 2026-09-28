/**
 * 앱 저장소 싱글턴 + React 훅.
 *
 * 앱 시작 때 `main.tsx` 가 `hydrateStores()` 를 기다린 뒤 화면을 그린다.
 * 그래서 화면에서는 **동기로** 읽는다: `playProgressStore.load(id)` · `savedCourseStore.list()`.
 * 값이 바뀌면 다시 그려지게 하려면 훅을 쓴다: `usePlayProgress(id)` · `useSavedCourses()`.
 *
 * 저장은 앱인토스 Storage SDK (`kvToss.ts`). 테스트는 각 파일의 `create…Store(createMemoryBackend())`.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { ReportAPI } from '../api/endpoints';
import type { Course } from '../api/types';
import { appStorage } from './kvToss';
import { createMissionReportQueue } from './missionReports';
import { createPlayProgressStore, type PlayProgress, type ProgressMap } from './playProgress';
import { createSelectedTabStore, createVoiceMutedStore } from './preferences';
import { courseIdentityKey, createSavedCourseStore, type SavedCourse } from './savedCourses';

export * from './playProgress';
export * from './savedCourses';
export * from './missionReports';
export type { AppTab } from './preferences';
export type { KeyValueBackend } from './kv';

// ── 싱글턴 ─────────────────────────────────────────────────────────────

export const playProgressStore = createPlayProgressStore(appStorage);
export const savedCourseStore = createSavedCourseStore(appStorage);
export const voiceMutedStore = createVoiceMutedStore(appStorage);
export const selectedTabStore = createSelectedTabStore(appStorage);
export const missionReportQueue = createMissionReportQueue(appStorage, async (r) => {
  try {
    await ReportAPI.mission({ playId: r.playId, missionId: r.missionId, reason: r.reason, note: r.note });
    return true;
  } catch {
    return false;
  }
});

/** 앱 시작 때 한 번. 모든 저장값을 메모리로 올린다. */
export async function hydrateStores(): Promise<void> {
  await Promise.all([
    playProgressStore.hydrate(),
    savedCourseStore.hydrate(),
    voiceMutedStore.hydrate(),
    selectedTabStore.hydrate(),
    missionReportQueue.hydrate(),
  ]);
}

// ── 훅 ─────────────────────────────────────────────────────────────────

/** PLAY 하나의 저장된 진행 (없으면 null). 저장·삭제되면 다시 그려진다. */
export function usePlayProgress(playId: string | null | undefined): PlayProgress | null {
  return useSyncExternalStore(playProgressStore.subscribe, () => (playId ? playProgressStore.load(playId) : null));
}

/** 모든 PLAY 진행 `{ [playId]: PlayProgress }` — 홈 카드 문구(「이어서 하기」/「다시 하기」)용. */
export function usePlayProgressMap(): ProgressMap {
  return useSyncExternalStore(playProgressStore.subscribe, playProgressStore.all);
}

/** 담아 둔 코스 목록, 최근 것부터. */
export function useSavedCourses(): SavedCourse[] {
  const raw = useSyncExternalStore(savedCourseStore.subscribe, savedCourseStore.raw.get);
  return useMemo(() => [...raw].sort((a, b) => b.savedAt - a.savedAt), [raw]);
}

/** 담아 둔 코스 하나 (key = savedCourseKey). 지워지면 null. */
export function useSavedCourse(key: string | null | undefined): SavedCourse | null {
  return useSyncExternalStore(savedCourseStore.subscribe, () => (key ? savedCourseStore.get(key) : null));
}

/** 이 코스를 이미 담았는가 — 신원(sourceCourseId)으로 본다. */
export function useIsCourseSaved(course: Pick<Course, 'id' | 'sourceCourseId'> | null | undefined): boolean {
  const key = course ? courseIdentityKey(course) : null;
  return useSyncExternalStore(savedCourseStore.subscribe, () => (key ? savedCourseStore.get(key) !== null : false));
}

/** 곱딱이 음성 끔 여부와 바꾸는 함수. */
export function useVoiceMuted(): [boolean, (muted: boolean) => void] {
  const muted = useSyncExternalStore(voiceMutedStore.subscribe, voiceMutedStore.get);
  const set = useCallback((m: boolean) => {
    voiceMutedStore.set(m).catch(() => undefined);
  }, []);
  return [muted, set];
}
