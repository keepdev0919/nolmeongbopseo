/**
 * PLAY 진행 저장·복원.
 *
 * 왜 이 테스트가 있나 — 성읍은 60~75분짜리다. 현장에서 앱이 내려가도 **완료한 미션까지는
 * 남아 있어야** 한다(2026-09-07 되살림). 이 약속이 깨지면 화면은 멀쩡한데 사용자는 대장간집부터
 * 다시 하게 된다 — 눈으로는 잘 안 보이는 고장이라 테스트로 지킨다.
 */
import { describe, expect, it } from 'vitest';
import { makePlay } from '../test/fixtures';
import { createMemoryBackend } from './kv';
import {
  PLAY_PROGRESS_KEY,
  beginPlay,
  clearedPointIds,
  createPlayProgress,
  createPlayProgressStore,
  progressLabel,
  resumeMissionIndex,
} from './playProgress';

/** 앱을 껐다 켠 것처럼 — 같은 저장소 위에 새 store 를 만들어 다시 읽는다. */
async function relaunch(backend: ReturnType<typeof createMemoryBackend>, now = () => 1_000) {
  const store = createPlayProgressStore(backend, { now });
  await store.hydrate();
  return store;
}

describe('PLAY 진행 저장소', () => {
  it('미션을 끝내고 저장하면 앱을 다시 켜도 그대로 남아 있다', async () => {
    const backend = createMemoryBackend();
    const play = makePlay();
    const store = await relaunch(backend);

    const p = createPlayProgress(play, 100);
    p.completedMissionIds.push('M01', 'M02');
    p.discoveredRecordIds.push('R1');
    store.save(p);
    await store.whenIdle();

    const again = await relaunch(backend);
    const restored = again.load(play.id);
    expect(restored?.completedMissionIds).toEqual(['M01', 'M02']);
    expect(restored?.discoveredRecordIds).toEqual(['R1']);
    expect(restored?.startedAt).toBe(100);
  });

  it('iOS 와 같은 키(play_progress_v1)에 { playId: 진행 } 모양으로 담는다', async () => {
    // 키나 모양이 조용히 바뀌면 이미 저장된 진행을 못 읽는다.
    const backend = createMemoryBackend();
    const store = await relaunch(backend);
    store.save(createPlayProgress(makePlay('a'), 1));
    await store.whenIdle();
    const raw = JSON.parse(backend.dump()[PLAY_PROGRESS_KEY]);
    expect(Object.keys(raw)).toEqual(['a']);
    expect(raw.a.playId).toBe('a');
  });

  it('save 는 updatedAt 을 지금으로 찍는다 — 홈 카드가 최근 것부터 줄 세우는 근거다', async () => {
    let t = 10;
    const store = createPlayProgressStore(createMemoryBackend(), { now: () => t });
    await store.hydrate();
    store.save(createPlayProgress(makePlay('a'), 0));
    t = 20;
    store.save(createPlayProgress(makePlay('b'), 0));
    t = 30;
    store.save({ ...store.load('a')! }); // a 를 다시 만짐
    expect(store.inProgress().map((p) => p.playId)).toEqual(['a', 'b']);
    expect(store.load('a')?.updatedAt).toBe(30);
  });

  it('여러 PLAY 를 동시에 붙잡고 있을 수 있다 — 하다 말고 다른 곳에 갔다 와도 둘 다 남는다', async () => {
    const backend = createMemoryBackend();
    const store = await relaunch(backend);
    const a = createPlayProgress(makePlay('a'), 0);
    a.completedMissionIds.push('M01');
    const b = createPlayProgress(makePlay('b'), 0);
    b.completedMissionIds.push('M03');
    store.save(a);
    store.save(b);
    await store.whenIdle();
    const again = await relaunch(backend);
    expect(again.load('a')?.completedMissionIds).toEqual(['M01']);
    expect(again.load('b')?.completedMissionIds).toEqual(['M03']);
  });

  it('CLEAR 한 PLAY 는 진행 중이 아니라 완료로 분류된다 (홈 카드 「다시 하기」)', async () => {
    const store = await relaunch(createMemoryBackend());
    const done = { ...createPlayProgress(makePlay('a'), 0), finalCleared: true };
    store.save(done);
    store.save(createPlayProgress(makePlay('b'), 0));
    expect(store.completed().map((p) => p.playId)).toEqual(['a']);
    expect(store.inProgress().map((p) => p.playId)).toEqual(['b']);
    expect(progressLabel(store.load('a'))).toBe('다시 하기');
    expect(progressLabel(store.load('b'))).toBe('이어서 하기');
    expect(progressLabel(store.load('none'))).toBeNull();
  });

  it('「처음부터 다시 하기」(clear) 는 그 PLAY 기록만 지우고 다시 켜도 돌아오지 않는다', async () => {
    const backend = createMemoryBackend();
    const store = await relaunch(backend);
    store.save(createPlayProgress(makePlay('a'), 0));
    store.save(createPlayProgress(makePlay('b'), 0));
    store.clear('a');
    await store.whenIdle();
    const again = await relaunch(backend);
    expect(again.load('a')).toBeNull();
    expect(again.load('b')).not.toBeNull();
  });

  it('못 읽는 저장값은 버리고 빈 상태로 시작한다 — 남겨두면 켤 때마다 실패를 반복한다', async () => {
    const broken = createMemoryBackend({ [PLAY_PROGRESS_KEY]: '{"a":{"playId":"a"}}' }); // 필드가 모자람
    const store = await relaunch(broken);
    expect(store.all()).toEqual({});
    expect(broken.dump()[PLAY_PROGRESS_KEY]).toBeUndefined();

    const garbage = createMemoryBackend({ [PLAY_PROGRESS_KEY]: 'not json' });
    const store2 = await relaunch(garbage);
    expect(store2.all()).toEqual({});
  });

  it('보다 만 발견·이야기 자리(pendingReveal)도 앱을 다시 켜면 남아 있다', async () => {
    const backend = createMemoryBackend();
    const store = await relaunch(backend);
    store.save({ ...createPlayProgress(makePlay('a'), 0), pendingReveal: { after: 'mission', missionId: 'M02', stage: 'story' } });
    await store.whenIdle();
    expect((await relaunch(backend)).load('a')?.pendingReveal).toEqual({ after: 'mission', missionId: 'M02', stage: 'story' });
  });

  it('pendingReveal 이 생기기 전 저장값도 읽고, 이상한 pendingReveal 때문에 진행 전체를 버리지 않는다', async () => {
    // 이미 폰에 있는 진행을 새 필드 때문에 날리면 사용자는 처음부터 다시 해야 한다.
    const { pendingReveal: _omit, ...old } = { ...createPlayProgress(makePlay('a'), 0), completedMissionIds: ['M01'] };
    const odd = { ...createPlayProgress(makePlay('b'), 0), completedMissionIds: ['M03'], pendingReveal: { after: '???' } };
    const backend = createMemoryBackend({ [PLAY_PROGRESS_KEY]: JSON.stringify({ a: old, b: odd }) });
    const store = await relaunch(backend);
    expect(store.load('a')?.completedMissionIds).toEqual(['M01']);
    expect(store.load('a')?.pendingReveal).toBeNull();
    expect(store.load('b')?.completedMissionIds).toEqual(['M03']);
    expect(store.load('b')?.pendingReveal).toBeNull();
  });

  it('없앤 FINAL 이야기 자리({ after: final })가 저장돼 있어도 진행은 살리고 그 자리만 버린다', async () => {
    // FINAL 뒤 이야기 칸은 2026-09-29 에 없앴다. 그 전 저장값을 읽다가 진행을 날리면 안 된다.
    const saved = { ...createPlayProgress(makePlay('a'), 0), completedMissionIds: ['M01'], pendingReveal: { after: 'final' } };
    const backend = createMemoryBackend({ [PLAY_PROGRESS_KEY]: JSON.stringify({ a: saved }) });
    const store = await relaunch(backend);
    expect(store.load('a')?.completedMissionIds).toEqual(['M01']);
    expect(store.load('a')?.pendingReveal).toBeNull();
  });

  it('저장소 쓰기가 실패해도 메모리의 진행은 남아 있다 — 이번 판은 끝까지 간다', async () => {
    const backend = createMemoryBackend();
    const store = await relaunch(backend);
    backend.failNextWrite();
    const p = createPlayProgress(makePlay('a'), 0);
    p.completedMissionIds.push('M01');
    store.save(p);
    await store.whenIdle();
    expect(store.load('a')?.completedMissionIds).toEqual(['M01']);
    // 다음 저장은 정상으로 나간다 (줄이 끊기지 않는다)
    store.save({ ...store.load('a')!, completedMissionIds: ['M01', 'M02'] });
    await store.whenIdle();
    const again = await relaunch(backend);
    expect(again.load('a')?.completedMissionIds).toEqual(['M01', 'M02']);
  });

  it('빠르게 연달아 저장해도 마지막 값이 남는다 (늦게 끝난 옛 쓰기가 덮지 않는다)', async () => {
    const backend = createMemoryBackend();
    const store = await relaunch(backend);
    const p = createPlayProgress(makePlay('a'), 0);
    store.save({ ...p, completedMissionIds: ['M01'] });
    store.save({ ...p, completedMissionIds: ['M01', 'M02'] });
    store.save({ ...p, completedMissionIds: ['M01', 'M02', 'M03'] });
    await store.whenIdle();
    const again = await relaunch(backend);
    expect(again.load('a')?.completedMissionIds).toEqual(['M01', 'M02', 'M03']);
  });
});

describe('이어받기 (러너 시작)', () => {
  it('저장된 진행이 있으면 **완료한 미션 다음**부터 시작한다', () => {
    const play = makePlay();
    const saved = createPlayProgress(play, 0);
    saved.completedMissionIds = ['M01', 'M02'];
    const r = beginPlay(play, saved);
    expect(r.resumed).toBe(true);
    expect(r.missionIndex).toBe(2); // M03
    expect(r.progress).toBe(saved);
  });

  it('건너뛴 미션도 완료로 친다 — 되돌아가 다시 풀게 하지 않는다', () => {
    const play = makePlay();
    const saved = createPlayProgress(play, 0);
    saved.completedMissionIds = ['M01'];
    saved.skippedMissionIds = ['M01'];
    expect(resumeMissionIndex(play, saved)).toBe(1);
  });

  it('미션을 전부 끝낸 채 나갔으면 마지막 미션 자리로 (러너가 FINAL 로 넘긴다)', () => {
    const play = makePlay();
    const saved = createPlayProgress(play, 0);
    saved.completedMissionIds = ['M01', 'M02', 'M03', 'M04'];
    expect(resumeMissionIndex(play, saved)).toBe(3);
  });

  it('이미 CLEAR 한 기록은 이어받지 않는다 — 「다시 하기」는 처음부터다', () => {
    const play = makePlay();
    const saved = { ...createPlayProgress(play, 0), completedMissionIds: ['M01', 'M02', 'M03', 'M04'], finalCleared: true };
    const r = beginPlay(play, saved, 500);
    expect(r.resumed).toBe(false);
    expect(r.missionIndex).toBe(0);
    expect(r.progress.completedMissionIds).toEqual([]);
    expect(r.progress.startedAt).toBe(500);
  });

  it('저장이 없으면 첫 Point 의 첫 미션에서 새로 시작한다', () => {
    const play = makePlay();
    const r = beginPlay(play, null, 7);
    expect(r).toMatchObject({ resumed: false, missionIndex: 0 });
    expect(r.progress).toMatchObject({ playId: play.id, currentPointId: 'P1', currentMissionId: 'M01', finalCleared: false });
  });

  it('진행 지도의 체크는 그 Point 의 미션을 **전부** 끝냈을 때만 붙는다', () => {
    const play = makePlay();
    const p = createPlayProgress(play, 0);
    p.completedMissionIds = ['M01'];
    expect([...clearedPointIds(play, p)]).toEqual([]);
    p.completedMissionIds = ['M01', 'M02', 'M03'];
    expect([...clearedPointIds(play, p)].sort()).toEqual(['P1', 'P2']);
  });
});
