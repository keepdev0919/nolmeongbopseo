import Foundation

/// 운영자 알림용으로 서버에 세 순간을 알린다 — `POST /event` (backend/routers/event.py).
///
///     first_open   이 기기에서 앱을 처음 켰다 (회원가입이 없어서 그 자리를 대신한다)
///     play_start   PLAY 를 처음부터 시작했다 (「이어서 하기」는 세지 않는다)
///     play_clear   PLAY 를 CLEAR 했다
///
/// ⚠️ 기기 ID·위치를 보내지 않는다. 어느 PLAY 인지, CLEAR 때 걸린 분·건너뛴 미션 수뿐이다
/// (backend/static/privacy.html §4). 여기에 무엇을 더하려면 처리방침부터 고친다.
///
/// 알림은 부가 기능이라 기다리지 않고, 실패해도 다시 보내지 않는다 — 첫 실행만 예외로,
/// 서버가 받을 때까지 다음 실행에 다시 보낸다.
enum AppEventReporter {
    private static let firstOpenKey = "app_event.first_open_sent_v1"

    private struct Payload: Encodable {
        let type: String
        let platform = "ios"
        var playId: String? = nil
        var minutes: Int? = nil
        var skipped: Int? = nil
    }
    private struct Ack: Decodable { let ok: Bool }

    /// 앱을 켤 때 부른다. 이 기기에서 한 번도 못 보냈을 때만 보낸다.
    static func firstOpenIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: firstOpenKey) else { return }
        Task {
            if await send(Payload(type: "first_open")) {
                UserDefaults.standard.set(true, forKey: firstOpenKey)
            }
        }
    }

    static func playStarted(playId: String) {
        Task { await send(Payload(type: "play_start", playId: playId)) }
    }

    static func playCleared(_ progress: PlayProgress) {
        let minutes = max(0, Int(Date().timeIntervalSince(progress.startedAt) / 60))
        Task {
            await send(Payload(type: "play_clear", playId: progress.playId,
                               minutes: minutes, skipped: progress.skippedMissionIds.count))
        }
    }

    @discardableResult
    private static func send(_ payload: Payload) async -> Bool {
        do {
            let _: Ack = try await APIClient.shared.post("/event", body: payload)
            return true
        } catch {
            return false
        }
    }
}
