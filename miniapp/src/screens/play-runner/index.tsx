/**
 * PLAY 진행 (러너) — 원본: Views/PlayRunnerView.swift (+ DesignSystem/PixelScene.swift,
 *   Components/MissionStepInput.swift, Components/MissionReportSheet.swift, Services/StoryAudioPlayer.swift)
 * 라우트: `/play/:playId/run` (탭바 숨김, iOS fullScreenCover 자리).
 *
 *     Point 도착 → Mission → Step 1..N → Discovery → Story → 다음 → FINAL → CLEAR
 *
 * ## 지키는 것
 * - **GPS 는 정답 판정기가 아니다.** 거리를 보여줄 뿐이고, 진행은 `[도착했어요]` 가 한다.
 * - **위치 권한이 없어도 끝까지 갈 수 있다.** 거리 줄이 안 뜰 뿐이다.
 * - **Mission 하나 때문에 관광이 막히지 않는다.** 힌트 2단계 → 건너뛰기가 항상 있다.
 * - **못 찾는 것과 없는 것은 다르다.** 현장이 자료와 다르면 신고할 수 있다.
 *
 * 흐름 계산은 `runnerLogic.ts`(테스트 있음), 음성은 `lineAudio.ts`, 장면 부품은 `scene.tsx`.
 *
 * ## 웹에서 달라진 것
 * - HUD 왼쪽 「나가기(X)」를 그리지 않는다 — 토스 네비게이션 바의 뒤로가기가 같은 확인창을 연다
 *   (앱인토스: 상단 뒤로가기를 직접 그리지 않음). 개발 브라우저의 뒤로가기도 `useBlocker` 로 같은 창을 연다.
 * - 스피커 옆에 「AI 음성」 표시 (Typecast 생성 음성 — 생성형 AI 표시 의무).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { PlayAPI, pointCoordinate, type MissionHint, type Play, type PlayPoint } from '../../api';
import { useBackHandler } from '../../app/backHandler';
import { useAppNavigation, usePlayRunnerParams } from '../../app/routes';
import { approxDistanceText, distanceMeters } from '../../lib/geo';
import { useUserLocation, type UserLocation } from '../../lib/location';
import { useResource } from '../../lib/resource';
import { missionReportQueue, playProgressStore } from '../../stores';
import { Icon, PixelColor, PixelDialog, PixelFont, PixelSpacing, PixelSpinner, PixelStyledButton } from '../../ui';
import { play as playLine, prefetchUpcoming, setMuted, stop as stopAudio, unlockWithGesture, useLineAudio, useMuted } from './lineAudio';
import { MissionReportSheet } from './MissionReportSheet';
import { MissionStepInput } from './MissionStepInput';
import {
  clearStats,
  currentLine,
  currentMission,
  currentPoint,
  currentStep,
  initRunner,
  isLastMission,
  ktoSourceLabel,
  nextLines,
  pointNumber,
  reduceRunner,
  reportTarget,
  speechKey,
  speechOf,
  waitsForSpeech,
  type RunnerAction,
  type RunnerState,
} from './runnerLogic';
import {
  InfoFrame,
  PixelDialogueBox,
  PixelHudButton,
  PixelHudProgress,
  PixelPortrait,
  PixelSceneBackground,
  PixelTypewriter,
  SceneBadge,
  SceneButton,
} from './scene';
import './play-runner.css';

/** 화자 이름. **곱딱이** (2026-09-03 조익준님 결정). 초상화는 앱 아이콘의 픽셀 감귤이다. */
const SPEAKER = '곱딱이';

/** 소리를 기다리다 너무 오래 걸리면 글자를 먼저 내보낸다. */
const SPEECH_GATE_MS = 2500;

export function PlayRunnerScreen() {
  const { playId, play: fromState } = usePlayRunnerParams();
  // 새로고침·딥링크로 들어오면 state 가 없다 — URL 의 id 로 다시 받는다.
  const { data, error, loading, reload } = useResource(fromState ? null : `play:${playId}`, () => PlayAPI.detail(playId));
  const play = fromState ?? data ?? null;
  if (play) return <Runner key={play.id} play={play} />;

  const failed = !!error && !loading;
  return (
    <div className="px-screen" style={{ height: '100%' }}>
      <div className="pr-status" role={failed ? 'alert' : 'status'}>
        {failed ? (
          <>
            <Icon name="warn" size={40} color={PixelColor.locked} />
            <p style={{ ...PixelFont.body, color: PixelColor.inkWeak, margin: 0 }}>PLAY 를 불러오지 못했어요.</p>
            <PixelStyledButton kind="plain" style={{ marginTop: PixelSpacing.s }} onClick={() => void reload()}>
              다시 시도
            </PixelStyledButton>
          </>
        ) : (
          <PixelSpinner />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════ 러너 ═══════════════════════════════

function Runner({ play }: { play: Play }) {
  const nav = useAppNavigation();
  const [state, setState] = useState<RunnerState>(() => initRunner(play, playProgressStore.load(play.id)));
  const stateRef = useRef(state);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [showQuit, setShowQuit] = useState(false);
  const [showReport, setShowReport] = useState(false);
  /** 곱딱이가 말을 다 한 줄(speechKey). 미션 칸을 언제 띄울지 이걸로 정한다. */
  const [doneKey, setDoneKey] = useState<string | null>(null);
  /** 소리를 2.5초 기다린 줄. */
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);
  /** 글자가 출발한 줄. 한 줄 안에서는 거짓 → 참으로만 바뀐다(소리가 끝나도 다시 기다리지 않는다). */
  const [readyKey, setReadyKey] = useState<string | null>(null);

  const muted = useMuted();
  const audio = useLineAudio();
  // 위치는 한 번만 받는다 (Swift requestCurrentLocationOnce). 거부하면 null — 거리 줄만 안 뜬다.
  const { location } = useUserLocation({ mode: 'once' });

  // 지난번에 못 보낸 신고가 있으면 지금 보낸다.
  useEffect(() => {
    void missionReportQueue.flush();
  }, []);
  // 화면을 떠나면 소리를 끊는다.
  useEffect(() => () => stopAudio(), []);

  const key = speechKey(play, state);
  const line = currentLine(play, state);

  /** 지금 대사를 읽고, 그 다음 두 줄을 미리 받아 둔다. 음소거면 재생만 건너뛴다. */
  const speak = useCallback(
    (l: string | null) => {
      if (!l) return;
      playLine(play.id, l);
      prefetchUpcoming(play.id, nextLines(play, l));
    },
    [play],
  );

  // 말이 바뀌면 다시 기다린다 — 대장간집 미션은 Step 이 둘이라 두 번째 질문도 곱딱이가 말하고 나서 보기가 뜬다.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    speak(currentLine(play, stateRef.current));
    const t = setTimeout(() => setTimedOutKey(key), SPEECH_GATE_MS);
    return () => clearTimeout(t);
  }, [key, play, speak]);

  /** 한 동작을 적용한다. 진행 기록이 바뀌었으면(미션 완료·CLEAR) 저장한다. */
  const dispatch = useCallback(
    (action: RunnerAction) => {
      const prev = stateRef.current;
      let next = reduceRunner(play, prev, action);
      if (next === prev) return;
      if (next.progress !== prev.progress) next = { ...next, progress: playProgressStore.save(next.progress) };
      stateRef.current = next;
      setState(next);
      // 말이 바뀌면 **탭 안에서** 다음 줄을 튼다 — 토스 WebView 는 탭 없이 소리를 못 낸다.
      if (speechKey(play, next) !== speechKey(play, prev)) speak(currentLine(play, next));
    },
    [play, speak],
  );

  // ── 글자는 소리와 함께 출발한다 (2026-09-11) ──
  // 소리가 준비되면, 꺼져 있으면, 못 불러오면, 2.5초가 지나면 글자를 내보낸다.
  const audioReady = audio.currentLine === line && (audio.state === 'playing' || audio.state === 'failed');
  const rawReady = !line || muted || timedOutKey === key || audioReady;
  if (rawReady && readyKey !== key) setReadyKey(key); // 렌더 중 맞추기 (한 번만 바뀐다)
  const speechReady = rawReady || readyKey === key;
  const speechDone = doneKey === key;
  const waits = waitsForSpeech(state.phase);
  const showsTask = !waits || speechDone;

  // ── 나가기 ──
  // 미션 단위로 저장한다 — 완료한 미션까지는 남고, 풀던 미션의 Step·힌트는 사라진다.
  const leavingRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => !leavingRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useBackHandler(() => setShowQuit(true));
  const leave = () => {
    leavingRef.current = true;
    stopAudio();
    if (blocker.state === 'blocked') blocker.proceed();
    else nav.back();
  };
  const closeQuit = () => {
    setShowQuit(false);
    if (blocker.state === 'blocked') blocker.reset();
  };

  const mission = currentMission(play, state);
  const point = currentPoint(play, state);
  const report = reportTarget(play, state);

  return (
    <div
      ref={rootRef}
      className="px-screen pr-root"
      style={{ height: '100%' }}
      onClick={(e) => {
        // 자동재생 제한으로 첫 줄이 막혔으면, 사용자가 처음 탭하는 순간 다시 튼다.
        // **버블 단계**에서 한다 — 버튼이 먼저 대사를 바꿨으면 새 줄이 이미 탭 안에서 나오고 있으니
        // 옛 줄을 틀었다가 곧바로 끊지 않는다 (unlockWithGesture 가 blocked 를 보고 알아서 넘어간다).
        if (rootRef.current?.contains(e.target as Node)) unlockWithGesture(play.id, currentLine(play, stateRef.current));
      }}
    >
      <PixelSceneBackground placeKey={play.placeKey} />

      {/* ── 상단 HUD — (나가기는 토스 뒤로가기) · 진행도 · 소리 스위치 ── */}
      <div className="pr-hud">
        <span aria-hidden="true" />
        <PixelHudProgress
          label={play.progressLabel ? play.progressLabel : '진행'}
          total={play.progressRecords.length}
          done={state.progress.discoveredRecordIds.length}
        />
        <div className="pr-hud__right">
          <span className="pr-ai-tag px-border" title="곱딱이 목소리는 AI 로 만든 음성이에요">
            AI 음성
          </span>
          <PixelHudButton
            glyph={muted ? 'soundOff' : 'sound'}
            label={muted ? '소리 켜기' : '소리 끄기'}
            onPress={() => {
              const next = !muted;
              setMuted(next);
              if (!next) speak(currentLine(play, stateRef.current));
            }}
          />
        </div>
      </div>

      {/* ── 아래 (정보판 + 대화창 + 버튼). 짧으면 아래에 붙고, 길면 이 안에서 스크롤한다 ── */}
      <div ref={scrollRef} className="pr-scroll">
        <div className="pr-bottom">
          {showsTask && infoSection()}
          <PixelDialogueBox showsNext={waits ? !speechDone : true}>
            {speechSection()}
          </PixelDialogueBox>
          {showsTask && actionRow()}
        </div>
      </div>

      <PixelDialog
        open={showQuit || blocker.state === 'blocked'}
        title="퀘스트를 그만할까요?"
        actions={[
          { label: '나가기 (완료한 지점까지 저장돼요)', role: 'destructive', onPress: leave },
          { label: '계속하기', role: 'cancel' },
        ]}
        onClose={closeQuit}
      />

      <MissionReportSheet
        open={showReport}
        playId={play.id}
        playTitle={play.title}
        missionId={report.id}
        missionTitle={report.title}
        onDone={() => setShowReport(false)}
      />
    </div>
  );

  // ─────────────────────────── 대화창 안 — 곱딱이가 말하는 것 ───────────────────────────

  function speechSection() {
    const speech = speechOf(play, state);
    if (!speech) return null;
    const source = speech.story ? ktoSourceLabel(speech.story) : null;
    return (
      <div className="pr-speech">
        <PixelPortrait />
        <div className="pr-speech__text">
          <span style={{ ...PixelFont.label, color: PixelColor.primary, letterSpacing: 2 }}>{SPEAKER}</span>
          <PixelTypewriter key={`${key}|${speech.text}`} text={speech.text} ready={speechReady} onFinished={() => setDoneKey(key)} />
          {/* 공공누리 출처표시 — 법적 의무라 대화상자 우측 하단에 작게 */}
          {source && <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak, textAlign: 'right' }}>{source}</span>}
        </div>
      </div>
    );
  }

  // ─────────────────────────── 대화창 위 — 곱딱이 말이 아닌 모든 것 ───────────────────────────

  function infoSection() {
    switch (state.phase) {
      case 'pointIntro':
        return point ? pointIntroInfo(point) : null;
      case 'mission':
        return missionInfo();
      case 'stepFeedback':
        return mission ? (
          <InfoFrame>
            <Title>{mission.title}</Title>
          </InfoFrame>
        ) : null;
      case 'discovery':
        return discoveryInfo();
      case 'story':
        return state.pendingStory?.title ? (
          <InfoFrame>
            <Title>{state.pendingStory.title}</Title>
          </InfoFrame>
        ) : null;
      case 'finalStage':
        return finalInfo();
      case 'clear':
        return clearInfo();
    }
  }

  /** 「가는 중」 — **도착한 뒤가 아니라 아직 안 갔을 때** 뜬다. 「대장간집으로 가세요」 → `[도착했어요]`. */
  function pointIntroInfo(p: PlayPoint) {
    return (
      <InfoFrame>
        <div className="pr-info__head">
          <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak }}>
            POINT {pointNumber(play, state)} / {play.points.length}
          </span>
          <DistanceRow point={p} location={location} />
        </div>
        <Title>{p.title}</Title>
        {p.navigationText && p.objective && <p style={{ ...PixelFont.body, color: PixelColor.inkWeak, margin: 0 }}>{p.objective}</p>}
      </InfoFrame>
    );
  }

  function missionInfo() {
    const step = currentStep(play, state);
    if (!mission || !step) return null;
    return (
      <InfoFrame>
        <div className="pr-info__head">
          <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak }}>{point?.title ?? ''}</span>
          <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak }}>MISSION</span>
        </div>
        <Title>{mission.title}</Title>

        {state.wrongMessage && (
          <div className="pr-row pr-box px-border" role="alert">
            <Icon name="refresh" size={16} color={PixelColor.locked} style={{ marginTop: 2 }} />
            <span style={{ ...PixelFont.body, color: PixelColor.locked }}>{state.wrongMessage}</span>
          </div>
        )}

        <MissionStepInput key={`${mission.id}:${state.stepIndex}`} step={step} onSubmit={(answer) => dispatch({ type: 'submit', answer })} />
        <RevealedHints hints={mission.hints} level={state.hintLevel} />

        {/*
          막히면 나갈 길이 항상 있다. 정보판 **안**에 둔다 — 밖은 배경 그림 위라 작은 글자가 안 읽힌다.
          「정답과 이야기 보기」는 힌트를 다 본 뒤에만 (힌트가 없는 미션은 바로). 「현장에서 찾을 수 없어요」는 항상.
        */}
        <div className="pr-escape" style={{ ...PixelFont.labelSmall }}>
          {state.hintLevel >= mission.hints.length && (
            <button type="button" className="px-reset-button" onClick={() => dispatch({ type: 'skip' })}>
              정답과 이야기 보기
            </button>
          )}
          <button type="button" className="px-reset-button" onClick={() => setShowReport(true)}>
            현장에서 찾을 수 없어요
          </button>
        </div>
      </InfoFrame>
    );
  }

  function discoveryInfo() {
    const d = state.pendingDiscovery;
    if (!d) return null;
    return (
      <>
        <SceneBadge text={state.lastSkipped ? '정답' : 'NEW DISCOVERY'} fill={PixelColor.accent} label={PixelColor.onAccent} />
        {/* 제목은 이름 있는 사물(정주석·물팡·호령창)에만 있다 — 없는 이름을 지어내지 않는다. */}
        {(d.title || state.justEarnedRecord) && (
          <InfoFrame>
            {d.title && <Title>{d.title}</Title>}
            {state.justEarnedRecord && (
              <div className="pr-box px-border" style={{ display: 'flex', alignItems: 'center', gap: PixelSpacing.s }}>
                <Icon name="check" size={18} color={PixelColor.primary} />
                <span style={{ ...PixelFont.label, color: PixelColor.ink }}>{state.justEarnedRecord} 기록 복원</span>
              </div>
            )}
          </InfoFrame>
        )}
      </>
    );
  }

  function finalInfo() {
    const final = play.final;
    if (!final) return null;
    return (
      <>
        <SceneBadge text="FINAL" fill={PixelColor.primary} label={PixelColor.onPrimary} />
        <InfoFrame>
          <Title>{final.title}</Title>
          {state.wrongMessage && (
            <p role="alert" style={{ ...PixelFont.body, color: PixelColor.locked, margin: 0 }}>
              {state.wrongMessage}
            </p>
          )}
          <MissionStepInput key="final" step={final.step} onSubmit={(answer) => dispatch({ type: 'submitFinal', answer })} />
          <RevealedHints hints={final.hints} level={state.hintLevel} />
        </InfoFrame>
      </>
    );
  }

  function clearInfo() {
    const stats = clearStats(play, state);
    return (
      <>
        <SceneBadge text="CLEAR" fill={PixelColor.primary} label={PixelColor.onPrimary} />
        <InfoFrame>
          <Title>{play.clear?.title ?? play.title}</Title>
          <div className="pr-stats">
            <StatBox value={stats.completed} label="완료 미션" />
            {stats.skipped > 0 && <StatBox value={String(stats.skipped)} label="건너뛴 미션" />}
            <StatBox value={stats.elapsed} label="걸린 시간" />
          </div>
        </InfoFrame>
      </>
    );
  }

  // ─────────────────────────── 아래 버튼 ───────────────────────────

  /** 가로 한 칸. 단계마다 하나만 필요하면 폭을 다 쓴다 — 억지로 뭘 채워 넣지 않는다. */
  function actionRow() {
    switch (state.phase) {
      case 'pointIntro':
        return <SceneButton title="도착했어요" filled onPress={() => dispatch({ type: 'arrived' })} />;
      case 'mission':
        return mission && state.hintLevel < mission.hints.length ? (
          <SceneButton
            title={state.hintLevel === 0 ? '힌트 보기' : '힌트 하나 더'}
            filled={false}
            onPress={() => dispatch({ type: 'showHint' })}
          />
        ) : null;
      case 'stepFeedback':
        return <SceneButton title="계속" filled onPress={() => dispatch({ type: 'afterStepFeedback' })} />;
      case 'discovery':
        return <SceneButton title="계속" filled onPress={() => dispatch({ type: 'afterDiscovery' })} />;
      case 'story':
        return (
          <SceneButton
            title={isLastMission(play, state) ? '마지막으로' : '다음'}
            filled
            onPress={() => {
              // 다음 화면으로 넘어가면 소리를 끊는다. 앞 이야기가 계속 흐르면 현실을 보는 데 방해가 된다.
              stopAudio();
              dispatch({ type: 'afterStory' });
            }}
          />
        );
      case 'finalStage': {
        const hints = play.final?.hints ?? [];
        return (
          <>
            {/* FINAL 은 720가지(6!) 순서 중 하나라 막히기 쉽다 — 여기도 힌트 2단계 (2026-09-07). */}
            {play.final && state.hintLevel < hints.length && (
              <SceneButton
                title={state.hintLevel === 0 ? '힌트 보기' : '힌트 하나 더'}
                filled={false}
                onPress={() => dispatch({ type: 'showFinalHint' })}
              />
            )}
            {/*
              개발 중 확인용 (Swift #if DEBUG). ⚠️ 배포 빌드에 나가면 「현실을 보고 발견한다」는
              이 앱의 전부가 버튼 한 번으로 사라진다 — import.meta.env.DEV 조건을 벗기지 말 것.
            */}
            {import.meta.env.DEV && (
              <SceneButton
                title={
                  <>
                    <span className="tf">🐞</span> 바로 통과
                  </>
                }
                filled={false}
                onPress={() => dispatch({ type: 'debugPassFinal' })}
              />
            )}
          </>
        );
      }
      case 'clear':
        return (
          <SceneButton
            title="PLAY 종료"
            filled
            onPress={() => {
              leavingRef.current = true;
              stopAudio();
              nav.back();
            }}
          />
        );
    }
  }
}

// ═══════════════════════════════ 작은 부품 ═══════════════════════════════

function Title({ children }: { children: ReactNode }) {
  return <h2 style={{ ...PixelFont.sectionTitle, color: PixelColor.ink, margin: 0 }}>{children}</h2>;
}

/** 거리 한 줄. **위치를 못 잡으면 그냥 안 뜬다** — 진행을 막지 않는다. 좌표는 단말에서만 쓴다. */
function DistanceRow({ point, location }: { point: PlayPoint; location: UserLocation | null }) {
  const c = pointCoordinate(point);
  if (!location || !c) return null;
  const meters = distanceMeters({ lat: location.lat, lng: location.lng }, c);
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: PixelSpacing.xs, flex: 'none' }}>
      <Icon name="target" size={14} color={PixelColor.primary} />
      <span style={{ ...PixelFont.labelSmall, color: PixelColor.primary }}>{approxDistanceText(meters)}</span>
    </span>
  );
}

function RevealedHints({ hints, level }: { hints: MissionHint[]; level: number }) {
  if (level <= 0) return null;
  return (
    <div className="pr-box px-border pr-stack-s">
      {hints.slice(0, level).map((hint, i) => (
        <div key={i} className="pr-row">
          <span className="pr-hint-tag" style={{ ...PixelFont.labelSmall }}>
            힌트 {i + 1}
          </span>
          <span style={{ ...PixelFont.body, color: PixelColor.ink }}>{hint.text}</span>
        </div>
      ))}
    </div>
  );
}

function StatBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="pr-stat px-border">
      <span style={{ ...PixelFont.label, color: PixelColor.ink }}>{value}</span>
      <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak }}>{label}</span>
    </div>
  );
}
