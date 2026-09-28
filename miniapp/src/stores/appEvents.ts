/**
 * 운영자 알림용으로 서버에 세 순간을 알린다 — Services/AppEventReporter.swift 이식. `POST /event`.
 *
 *   first_open   이 기기에서 미니앱을 처음 켰다 (회원가입이 없어서 그 자리를 대신한다)
 *   play_start   PLAY 를 처음부터 시작했다 (「이어서 하기」는 세지 않는다)
 *   play_clear   PLAY 를 CLEAR 했다
 *
 * ⚠️ 기기 ID·위치를 보내지 않는다. 어느 PLAY 인지, CLEAR 때 걸린 분·건너뛴 미션 수뿐이다
 *    (backend/static/privacy.html §4). 여기에 무엇을 더하려면 처리방침부터 고친다.
 *
 * 알림은 부가 기능이라 기다리지 않고, 실패해도 다시 보내지 않는다 — 첫 실행만 예외로,
 * 서버가 받을 때까지 다음 실행에 다시 보낸다. 저장 키 `app_event.first_open_sent_v1`.
 */
import type { AppEventBody } from '../api/endpoints';
import { createJsonStore } from './jsonStore';
import type { KeyValueBackend } from './kv';
import type { PlayProgress } from './playProgress';

export const FIRST_OPEN_SENT_KEY = 'app_event.first_open_sent_v1';

/** 보내기 성공이면 true. 앱에서는 EventAPI.send 를 감싼 함수를 넣는다. */
export type SendEvent = (body: AppEventBody) => Promise<boolean>;

export function createAppEventReporter(backend: KeyValueBackend, send: SendEvent) {
  const firstOpenSent = createJsonStore<boolean>({
    backend,
    key: FIRST_OPEN_SENT_KEY,
    empty: () => false,
    parse: (v) => (typeof v === 'boolean' ? v : null),
  });

  return {
    hydrate: () => firstOpenSent.hydrate(),
    /** 앱을 켤 때 부른다. 이 기기에서 한 번도 못 보냈을 때만 보낸다. */
    async firstOpenIfNeeded(): Promise<void> {
      // 앱은 저장소를 3초까지만 기다리고 화면을 그린다. 그보다 늦으면 아직 못 읽은 「false」를 보고
      // 이미 알린 기기가 또 「새 기기」로 알려진다 — 여기서는 끝까지 읽고 판단한다.
      if (!firstOpenSent.isHydrated()) await firstOpenSent.hydrate();
      if (firstOpenSent.get()) return;
      if (await send({ type: 'first_open', platform: 'toss' })) {
        await firstOpenSent.set(true).catch(() => undefined);
      }
    },
    playStarted(playId: string): void {
      void send({ type: 'play_start', platform: 'toss', playId });
    },
    playCleared(progress: PlayProgress, now: number = Date.now()): void {
      void send({
        type: 'play_clear',
        platform: 'toss',
        playId: progress.playId,
        minutes: Math.max(0, Math.floor((now - progress.startedAt) / 60_000)),
        skipped: progress.skippedMissionIds.length,
      });
    },
    whenIdle: () => firstOpenSent.whenIdle(),
  };
}
