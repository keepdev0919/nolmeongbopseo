/**
 * PLAY 진행의 **순수 로직** — PlayRunnerView.swift 의 `RunnerViewModel` 과 화면 계산값 이식.
 *
 *     Point 도착 → Mission → Step 1..N → Discovery → Story → 다음 → FINAL → CLEAR
 *
 * React·SDK 를 모른다. 화면(index.tsx)은 `reduceRunner()` 로 다음 상태를 받고, 진행 기록
 * (`progress`)이 바뀌었으면 저장소에 저장한다. 정답 판정(`isCorrect`)은 공용 `api/models` 것을 쓴다.
 *
 * ## 지키는 것 (Swift 주석 그대로)
 * - **GPS 는 정답 판정기가 아니다.** 진행은 `[도착했어요]` 가 한다.
 * - **Mission 하나 때문에 관광이 막히지 않는다.** 힌트 2단계 → 건너뛰기가 항상 있다.
 * - **미션 단위로 저장한다.** 미션을 끝낼 때와 CLEAR 때 progress 가 새 객체로 바뀐다 —
 *   화면은 그걸 보고 저장한다. 풀던 미션의 Step·힌트는 저장하지 않는다.
 *   끝낸 미션 뒤 발견 → 이야기로 넘어갈 때, 다 보고 다음으로 갈 때도 저장한다 — 보다 만
 *   발견·이야기 자리(`pendingReveal`)를 적고 지우기 위해서다.
 */
import { failureText, isCorrect, missionCount, orderedMissions, partialCorrectCount, storyAfter } from '../../api/models';
import type {
  Mission,
  MissionAnswer,
  MissionDiscovery,
  MissionStep,
  Play,
  PlayPoint,
  PlayStory,
  StorySource,
} from '../../api/types';
import { createPlayProgress, isFinished, resumeMissionIndex, type PlayProgress } from '../../stores/playProgress';

// ═══════════════════════════════ 상태 ═══════════════════════════════

export type RunnerPhase = 'pointIntro' | 'mission' | 'stepFeedback' | 'discovery' | 'story' | 'finalStage' | 'clear';

export interface RunnerState {
  phase: RunnerPhase;
  missionIndex: number;
  stepIndex: number;
  hintLevel: number;
  wrongMessage: string | null;
  /** 맞혔을 때 곱딱이가 해 주는 말. 원고가 적어 둔 Step 에만 있다. */
  pendingSuccess: string | null;
  pendingDiscovery: MissionDiscovery | null;
  pendingStory: PlayStory | null;
  justEarnedRecord: string | null;
  lastSkipped: boolean;
  progress: PlayProgress;
  /** 이미 안내를 마친 Point. 같은 Point 의 두 번째 미션에서 또 도착 화면을 띄우지 않는다. */
  introducedPointIds: string[];
}

export type RunnerAction =
  | { type: 'arrived' }
  | { type: 'showHint' }
  | { type: 'showFinalHint' }
  | { type: 'submit'; answer: MissionAnswer }
  | { type: 'afterStepFeedback' }
  | { type: 'skip' }
  | { type: 'afterDiscovery' }
  | { type: 'afterStory' }
  | { type: 'submitFinal'; answer: MissionAnswer }
  /** 개발 중 확인용 (Swift `#if DEBUG` debugPassFinal). 배포 빌드 화면에는 버튼이 없다. */
  | { type: 'debugPassFinal' };

const flatOf = (play: Play) => orderedMissions(play);

/**
 * 러너가 열릴 때의 상태 (RunnerViewModel.init).
 *
 * **저장된 진행이 있으면 이어받는다.** 이미 CLEAR 한 기록은 이어받지 않는다 — 「다시 하기」는
 * 처음부터가 맞다. 이어받을 때는 **완료한 미션 다음**의 Point 안내부터 시작한다.
 *
 * 미션을 전부 끝냈는데 CLEAR 전(FINAL 에서 나감)이면 **FINAL 부터** 다시 연다 — 공용
 * `resumeMissionIndex` 계약(「러너가 FINAL 로 넘긴다」). (2026-09-15 iOS 도 같게 고침)
 *
 * 끝낸 미션의 발견·이야기를 보다가 나갔으면 **그 자리부터** 다시 연다
 * (`progress.pendingReveal`, 2026-09-15). 원고가 바뀌어 그 발견·이야기를 못 찾으면 위 규칙대로.
 */
export function initRunner(play: Play, saved: PlayProgress | null, now: number = Date.now()): RunnerState {
  const base = {
    stepIndex: 0,
    hintLevel: 0,
    wrongMessage: null,
    pendingSuccess: null,
    pendingDiscovery: null,
    pendingStory: null,
    justEarnedRecord: null,
    lastSkipped: false,
    introducedPointIds: [],
  };
  if (saved && !isFinished(saved)) {
    const flat = flatOf(play);
    const reveal = resumeReveal(play, saved);
    if (reveal) return { ...base, ...reveal, progress: saved };
    const allDone = flat.length > 0 && flat.every(({ mission }) => saved.completedMissionIds.includes(mission.id));
    return {
      ...base,
      phase: allDone && play.final ? 'finalStage' : 'pointIntro',
      missionIndex: resumeMissionIndex(play, saved),
      progress: saved,
    };
  }
  return { ...base, phase: 'pointIntro', missionIndex: 0, progress: createPlayProgress(play, now) };
}

/** 보다 만 발견·이야기로 되돌아갈 상태 조각. 원고에서 못 찾으면 null. */
function resumeReveal(
  play: Play,
  saved: PlayProgress,
): (Partial<RunnerState> & Pick<RunnerState, 'phase' | 'missionIndex'>) | null {
  const pending = saved.pendingReveal;
  if (!pending) return null;
  const flat = flatOf(play);
  const missionIndex = flat.findIndex(({ mission }) => mission.id === pending.missionId);
  if (missionIndex < 0) return null;
  const { point, mission } = flat[missionIndex];
  const story = storyAfter(play, mission.id) ?? null;
  const common = {
    missionIndex,
    pendingStory: story,
    lastSkipped: saved.skippedMissionIds.includes(mission.id),
    // 이 Point 는 이미 안내를 마쳤다 — 같은 Point 의 다음 미션에서 도착 안내를 다시 띄우지 않는다.
    introducedPointIds: [point.id],
  };
  if (pending.stage === 'discovery' && mission.discovery) {
    return { ...common, phase: 'discovery', pendingDiscovery: mission.discovery };
  }
  if (story) return { ...common, phase: 'story' };
  return null;
}

// ═══════════════════════════════ 조회 ═══════════════════════════════

export function currentPoint(play: Play, s: RunnerState): PlayPoint | null {
  return flatOf(play)[s.missionIndex]?.point ?? null;
}

export function currentMission(play: Play, s: RunnerState): Mission | null {
  return flatOf(play)[s.missionIndex]?.mission ?? null;
}

export function currentStep(play: Play, s: RunnerState): MissionStep | null {
  return currentMission(play, s)?.steps[s.stepIndex] ?? null;
}

export function isLastMission(play: Play, s: RunnerState): boolean {
  return s.missionIndex >= flatOf(play).length - 1;
}

/** 「POINT 2 / 4」의 2. */
export function pointNumber(play: Play, s: RunnerState): number {
  const p = currentPoint(play, s);
  if (!p) return 1;
  const i = play.points.findIndex((x) => x.id === p.id);
  return (i >= 0 ? i : 0) + 1;
}

/** 「12분」 / 「1시간 5분」 — CLEAR 의 걸린 시간. */
export function elapsedText(startedAt: number, now: number = Date.now()): string {
  const m = Math.floor((now - startedAt) / 60_000);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** CLEAR 통계. */
export function clearStats(play: Play, s: RunnerState, now: number = Date.now()) {
  return {
    completed: `${s.progress.completedMissionIds.length} / ${missionCount(play)}`,
    skipped: s.progress.skippedMissionIds.length,
    elapsed: elapsedText(s.progress.startedAt, now),
  };
}

// ═══════════════════════════════ 진행 ═══════════════════════════════

/** 한 동작을 적용한 다음 상태. `progress` 가 새 객체면 저장할 때다. */
export function reduceRunner(play: Play, s: RunnerState, action: RunnerAction): RunnerState {
  switch (action.type) {
    case 'arrived': {
      const p = currentPoint(play, s);
      const introduced = p && !s.introducedPointIds.includes(p.id) ? [...s.introducedPointIds, p.id] : s.introducedPointIds;
      return { ...s, introducedPointIds: introduced, wrongMessage: null, phase: 'mission' };
    }
    case 'showHint': {
      const m = currentMission(play, s);
      if (!m) return s;
      return { ...s, hintLevel: Math.min(s.hintLevel + 1, m.hints.length) };
    }
    case 'showFinalHint': {
      const hints = play.final?.hints;
      if (!hints) return s;
      return { ...s, hintLevel: Math.min(s.hintLevel + 1, hints.length) };
    }
    case 'submit': {
      const step = currentStep(play, s);
      const mission = currentMission(play, s);
      if (!step || !mission) return s;
      if (!isCorrect(step, action.answer)) return { ...s, wrongMessage: failureText(step) };
      // **맞혔다는 말을 삼키지 않는다** (2026-09-04). 원고가 성공 문구를 적어 둔 Step 은
      // 그 말을 먼저 듣고 넘어간다.
      if (step.successFeedback) {
        return { ...s, wrongMessage: null, pendingSuccess: step.successFeedback, phase: 'stepFeedback' };
      }
      return proceedAfterStep(play, { ...s, wrongMessage: null }, mission);
    }
    case 'afterStepFeedback': {
      const next = { ...s, pendingSuccess: null };
      const mission = currentMission(play, next);
      if (!mission) return next;
      return proceedAfterStep(play, next, mission);
    }
    case 'skip': {
      // 건너뛰기 — 정답과 이야기를 열고 계속 간다. **진행이 막히지 않는다.**
      const mission = currentMission(play, s);
      if (!mission) return s;
      const skipped = s.progress.skippedMissionIds.includes(mission.id)
        ? s.progress.skippedMissionIds
        : [...s.progress.skippedMissionIds, mission.id];
      return completeMission(play, { ...s, progress: { ...s.progress, skippedMissionIds: skipped } }, mission, true);
    }
    case 'afterDiscovery': {
      if (!s.pendingStory) return advance(play, s);
      // 보다 만 자리를 「이야기」로 옮겨 저장한다 — 이야기 중에 나가도 이야기부터 다시 연다.
      const pending = s.progress.pendingReveal;
      const progress = pending?.after === 'mission' ? { ...s.progress, pendingReveal: { ...pending, stage: 'story' as const } } : s.progress;
      return { ...s, progress, phase: 'story' };
    }
    case 'afterStory':
      return advance(play, s);
    case 'submitFinal': {
      const final = play.final;
      if (!final) return finish(s);
      if (!isCorrect(final.step, action.answer)) {
        // 틀렸을 때 "몇 개 중 몇 개는 맞았는지"를 먼저 말해준다 (2026-09-07).
        const n = partialCorrectCount(final.step, action.answer);
        const msg =
          n !== null
            ? `${final.step.options.length}개 중 ${n}개는 순서가 맞았어! ` + failureText(final.step)
            : failureText(final.step);
        return { ...s, wrongMessage: msg };
      }
      // FINAL 을 맞히면 바로 CLEAR 다 — FINAL 뒤 이야기는 없다 (2026-09-29 결정).
      return finish({ ...s, wrongMessage: null });
    }
    case 'debugPassFinal':
      // 정답 경로와 **같은 길**(바로 CLEAR)을 탄다.
      return finish({ ...s, wrongMessage: null });
  }
}

function proceedAfterStep(play: Play, s: RunnerState, mission: Mission): RunnerState {
  if (s.stepIndex + 1 < mission.steps.length) return { ...s, stepIndex: s.stepIndex + 1, phase: 'mission' };
  return completeMission(play, s, mission, false);
}

function completeMission(play: Play, s: RunnerState, mission: Mission, skipped: boolean): RunnerState {
  const completed = s.progress.completedMissionIds.includes(mission.id)
    ? s.progress.completedMissionIds
    : [...s.progress.completedMissionIds, mission.id];
  // 진행도 칸. 모든 미션이 칸을 채우지는 않는다 — 앞 미션이 뒤 미션의 발견을 준비하는 경우가 있다.
  let discovered = s.progress.discoveredRecordIds;
  let justEarnedRecord: string | null = null;
  const reward = mission.progressReward;
  if (reward && !discovered.includes(reward)) {
    discovered = [...discovered, reward];
    justEarnedRecord = play.progressRecords.find((r) => r.id === reward)?.label ?? null;
  }
  const pendingDiscovery = mission.discovery;
  const pendingStory = storyAfter(play, mission.id) ?? null;
  const next: RunnerState = {
    ...s,
    lastSkipped: skipped,
    justEarnedRecord,
    // 오답을 내고 건너뛴 미션의 문구가 다음 미션·FINAL 에 남지 않게 한다.
    // (Swift 는 여기서 비우지 않아 같은 Point 의 다음 미션과 FINAL 에 앞 미션 오답이 떠 있었다.)
    wrongMessage: null,
    pendingSuccess: null,
    pendingDiscovery,
    pendingStory,
    hintLevel: 0,
    stepIndex: 0,
    // 새 객체 → 화면이 저장한다 (미션 단위 저장). 뒤에 볼 발견·이야기가 있으면 그 자리도 같이.
    progress: {
      ...s.progress,
      completedMissionIds: completed,
      discoveredRecordIds: discovered,
      pendingReveal: pendingDiscovery
        ? { after: 'mission', missionId: mission.id, stage: 'discovery' }
        : pendingStory
          ? { after: 'mission', missionId: mission.id, stage: 'story' }
          : null,
    },
  };
  // Discovery 가 없는 미션이 있다 — 다음 미션의 발견을 준비하는 것이다. 그때는 발견 화면을 건너뛴다.
  if (pendingDiscovery) return { ...next, phase: 'discovery' };
  if (pendingStory) return { ...next, phase: 'story' };
  return advance(play, next);
}

/** 다음 미션으로. 같은 Point 면 바로 미션, 다른 Point 면 도착 안내부터. */
function advance(play: Play, s: RunnerState): RunnerState {
  const flat = flatOf(play);
  // 발견·이야기를 다 봤다 — 보다 만 자리 기록을 지운다 (바뀔 때만 새 객체 = 저장).
  const progress = s.progress.pendingReveal ? { ...s.progress, pendingReveal: null } : s.progress;
  const cleared = { ...s, progress, pendingDiscovery: null, pendingStory: null, justEarnedRecord: null, wrongMessage: null };
  if (s.missionIndex + 1 < flat.length) {
    const missionIndex = s.missionIndex + 1;
    const nextPoint = flat[missionIndex].point;
    return {
      ...cleared,
      missionIndex,
      stepIndex: 0,
      hintLevel: 0,
      phase: s.introducedPointIds.includes(nextPoint.id) ? 'mission' : 'pointIntro',
    };
  }
  if (play.final) return { ...cleared, hintLevel: 0, phase: 'finalStage' };
  return finish(cleared);
}

/** CLEAR 기록을 남긴다 — 홈 카드가 「다시 하기」로 바뀌는 근거다. */
function finish(s: RunnerState): RunnerState {
  return { ...s, progress: { ...s.progress, finalCleared: true, pendingReveal: null }, phase: 'clear' };
}

// ═══════════════════════════════ 곱딱이 대사 ═══════════════════════════════

/**
 * **곱딱이 말이 끝난 뒤에 위 칸이 나타나는 단계** (2026-09-04).
 * 미션·FINAL 은 답을 넣어야 해서, 발견은 상이 설명보다 먼저 오지 않게 하려고 기다린다.
 */
export function waitsForSpeech(phase: RunnerPhase): boolean {
  return phase === 'mission' || phase === 'finalStage' || phase === 'discovery';
}

/** 말이 바뀌었는지 알아보는 열쇠. 단계·미션·Step 중 하나만 바뀌어도 달라진다. */
export function speechKey(play: Play, s: RunnerState): string {
  return `${s.phase}-${currentMission(play, s)?.id ?? ''}-${s.stepIndex}`;
}

/** 첫 Step 에서는 미션 안내 + 질문, 뒤 Step 은 질문만. 같은 글을 세 번 읽게 하지 않는다. */
export function missionSpeech(mission: Mission, step: MissionStep, stepIndex: number): string {
  if (stepIndex === 0 && mission.prompt) {
    return step.prompt ? `${mission.prompt}\n\n${step.prompt}` : mission.prompt;
  }
  return step.prompt ? step.prompt : mission.prompt;
}

/** 대화창 **안** — 곱딱이가 지금 하는 말. 없으면 null (대화창은 빈 채로 둔다). */
export function speechOf(play: Play, s: RunnerState): { text: string; story: PlayStory | null } | null {
  switch (s.phase) {
    case 'pointIntro': {
      const p = currentPoint(play, s);
      return p ? { text: p.navigationText ? p.navigationText : p.objective, story: null } : null;
    }
    case 'mission': {
      const m = currentMission(play, s);
      const st = currentStep(play, s);
      return m && st ? { text: missionSpeech(m, st, s.stepIndex), story: null } : null;
    }
    case 'stepFeedback':
      return s.pendingSuccess !== null ? { text: s.pendingSuccess, story: null } : null;
    case 'discovery':
      return s.pendingDiscovery ? { text: s.pendingDiscovery.body, story: null } : null;
    case 'story':
      return s.pendingStory ? { text: s.pendingStory.script, story: s.pendingStory } : null;
    case 'finalStage':
      return play.final ? { text: play.final.prompt, story: null } : null;
    case 'clear':
      return play.clear?.body ? { text: play.clear.body, story: null } : null;
  }
}

/** 지금 대사를 가리키는 열쇠. 서버 `resolve_line` 과 같은 형식 — 문장을 보내지 않고 열쇠만 보낸다. */
export function currentLine(play: Play, s: RunnerState): string | null {
  switch (s.phase) {
    case 'pointIntro': {
      const p = currentPoint(play, s);
      return p ? `point:${p.id}` : null;
    }
    case 'mission': {
      const m = currentMission(play, s);
      return m ? `mission:${m.id}:${s.stepIndex}` : null;
    }
    case 'stepFeedback': {
      const m = currentMission(play, s);
      return s.pendingSuccess !== null && m ? `feedback:${m.id}:${s.stepIndex}` : null;
    }
    case 'discovery': {
      const m = currentMission(play, s);
      return s.pendingDiscovery && m ? `discovery:${m.id}` : null;
    }
    case 'story':
      return s.pendingStory ? `story:${s.pendingStory.id}` : null;
    case 'finalStage':
      return play.final ? 'final' : null;
    case 'clear':
      return play.clear?.body ? 'clear' : null;
  }
}

/** 곱딱이 대사가 나올 순서. 미리 받아 둘 때 쓴다. */
export function speechOrder(play: Play): string[] {
  const order: string[] = [];
  for (const point of play.points) {
    order.push(`point:${point.id}`);
    for (const mission of point.missions) {
      mission.steps.forEach((step, i) => {
        order.push(`mission:${mission.id}:${i}`);
        if (step.successFeedback) order.push(`feedback:${mission.id}:${i}`);
      });
      if (mission.discovery?.body) order.push(`discovery:${mission.id}`);
      const story = play.stories.find((st) => st.unlockAfterMission === mission.id);
      if (story) order.push(`story:${story.id}`);
    }
  }
  if (play.final) {
    order.push('final');
  }
  if (play.clear?.body) order.push('clear');
  return order;
}

/** 지금 줄 다음의 두 줄 (미리 받기). 지금 줄이 순서에 없으면 빈 배열. */
export function nextLines(play: Play, line: string, count = 2): string[] {
  const order = speechOrder(play);
  const i = order.indexOf(line);
  return i < 0 ? [] : order.slice(i + 1, i + 1 + count);
}

// ═══════════════════════════════ 출처 ═══════════════════════════════

/** 출처 한 줄. 공지가 지정한 형식은 텍스트만 허용한다 — 로고·CI 는 금지다. */
export function sourceLabel(s: StorySource): string {
  switch (s.kind) {
    case 'odii':
    case 'kto':
      return '출처: ⓒ한국관광공사' + (s.ref ? ` (${s.ref})` : '');
    case 'encykorea':
      return `한국민족문화대백과사전 ${s.ref}`;
    case 'heritage':
      return `국가유산 공식자료 ${s.ref}`;
    default:
      return s.ref ? `${s.kind} ${s.ref}` : s.kind;
  }
}

/**
 * 한국관광공사(오디) 출처만 골라 표시 문구를 만든다. 없으면 null.
 * 공공누리 출처표시는 법적 의무라 대화상자 우측 하단에 작게 남긴다 (2026-09-07).
 */
export function ktoSourceLabel(story: PlayStory): string | null {
  const s = story.sources.find((x) => x.kind === 'odii' || x.kind === 'kto');
  return s ? sourceLabel(s) : null;
}

// ═══════════════════════════════ 신고 대상 ═══════════════════════════════

/** 「현장에서 찾을 수 없어요」가 가리키는 미션 (Swift: currentMission ?? final). */
export function reportTarget(play: Play, s: RunnerState): { id: string; title: string } {
  const m = currentMission(play, s);
  return { id: m?.id ?? play.final?.id ?? '', title: m?.title ?? play.final?.title ?? '' };
}
