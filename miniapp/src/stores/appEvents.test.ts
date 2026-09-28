/**
 * 운영자 알림 (앱 첫 실행 · PLAY 시작 · CLEAR).
 *
 * 왜 이 테스트가 있나 — 「첫 실행」은 가입 알림 자리라 **기기마다 한 번**이어야 숫자가 맞는다.
 * 켤 때마다 오면 새 사용자로 잘못 세고, 실패했는데 보냈다고 적으면 영영 안 온다.
 * 그리고 기기 ID 같은 식별자가 실리면 처리방침 §4 의 약속이 깨진다.
 */
import { describe, expect, it } from 'vitest';
import type { AppEventBody } from '../api/endpoints';
import { createAppEventReporter, FIRST_OPEN_SENT_KEY } from './appEvents';
import { createMemoryBackend } from './kv';
import type { PlayProgress } from './playProgress';

function setup(ok = true, initial: Record<string, string> = {}) {
  const backend = createMemoryBackend(initial);
  const sent: AppEventBody[] = [];
  let succeed = ok;
  const reporter = createAppEventReporter(backend, async (b) => {
    sent.push(b);
    return succeed;
  });
  return { backend, sent, reporter, setOk: (v: boolean) => (succeed = v) };
}

describe('앱 첫 실행', () => {
  it('보내는 데 성공하면 이 기기에서 다시 보내지 않는다', async () => {
    const { sent, reporter, backend } = setup();
    await reporter.hydrate();
    await reporter.firstOpenIfNeeded();
    await reporter.whenIdle();
    expect(sent).toEqual([{ type: 'first_open', platform: 'toss' }]);

    // 다음 실행 — 저장소에서 다시 읽는다
    const again = createAppEventReporter(backend, async (b) => (sent.push(b), true));
    await again.hydrate();
    await again.firstOpenIfNeeded();
    expect(sent).toHaveLength(1);
  });

  it('실패하면 다음 실행에 다시 보낸다', async () => {
    const { sent, reporter, backend, setOk } = setup(false);
    await reporter.hydrate();
    await reporter.firstOpenIfNeeded();
    expect(backend.dump()[FIRST_OPEN_SENT_KEY]).toBeUndefined();

    setOk(true);
    await reporter.firstOpenIfNeeded();
    expect(sent).toHaveLength(2);
  });
});

describe('PLAY 시작·CLEAR', () => {
  it('CLEAR 는 걸린 분과 건너뛴 미션 수만 싣는다', () => {
    const { sent, reporter } = setup();
    const progress = {
      playId: 'seongeup-restore',
      startedAt: 0,
      skippedMissionIds: ['m03'],
      completedMissionIds: ['m01', 'm02'],
    } as unknown as PlayProgress;
    reporter.playCleared(progress, 52 * 60_000 + 30_000);
    expect(sent).toEqual([
      { type: 'play_clear', platform: 'toss', playId: 'seongeup-restore', minutes: 52, skipped: 1 },
    ]);
  });

  it('시작은 PLAY id 만 싣는다', () => {
    const { sent, reporter } = setup();
    reporter.playStarted('seongeup-restore');
    expect(sent).toEqual([{ type: 'play_start', platform: 'toss', playId: 'seongeup-restore' }]);
  });
});
