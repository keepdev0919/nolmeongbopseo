import XCTest
@testable import JejuFolklore

/// **성읍을 처음부터 끝까지 풀면 CLEAR 에 닿는다.**
///
/// 앱스토어에 나간 PLAY 는 성읍 하나다. 어느 한 단계에서 러너가 앞 화면으로
/// 되돌아가면 사용자는 현장에서 CLEAR 를 못 하고, 클리어 기록도 남지 않는다.
/// 그래서 서버가 실제로 내려주는 원고(`Fixtures/seongeup.json`, 사본이 어긋나면
/// `tests/test_ios_play_fixture.py` 가 잡는다)로 사용자가 누르는 순서 그대로 끝까지 간다.
///
/// FINAL 은 한 번만 나와야 한다 — FINAL 을 맞힌 뒤 다시 FINAL 이 뜨면 끝나지 않는다.
@MainActor
final class PlayRunnerClearTests: XCTestCase {

    private let progressKey = "play_progress_v1"
    private var savedProgress: Data?

    // 시뮬레이터에 남아 있던 진행 기록을 건드리지 않는다 — 테스트 앞뒤로 되돌려 둔다.
    override func setUp() async throws {
        savedProgress = UserDefaults.standard.data(forKey: progressKey)
        UserDefaults.standard.removeObject(forKey: progressKey)
    }

    override func tearDown() async throws {
        if let savedProgress {
            UserDefaults.standard.set(savedProgress, forKey: progressKey)
        } else {
            UserDefaults.standard.removeObject(forKey: progressKey)
        }
    }

    private func loadSeongeup() throws -> Play {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "seongeup", withExtension: "json"),
            "Fixtures/seongeup.json 이 테스트 번들에 없습니다"
        )
        // 앱이 서버 응답을 읽는 방식(APIClient)과 같게 읽는다.
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Play.self, from: Data(contentsOf: url))
    }

    /// 원고에 적힌 정답을 사용자가 넣는 모양으로.
    private func correctAnswer(_ step: MissionStep) -> MissionAnswer {
        if step.inputType == .shortText, case .list(let allowed) = step.answer, let first = allowed.first {
            return .text(first)
        }
        return step.answer
    }

    /// 사용자가 화면에서 누르는 대로 끝까지 간다. 미션은 `solve` 가 정한다.
    private func playThrough(_ vm: RunnerViewModel, solve: (RunnerViewModel) -> Void) -> (finalShown: Int, steps: Int) {
        var finalShown = vm.phase == .finalStage ? 1 : 0
        var steps = 0
        while vm.phase != .clear && steps < 500 {
            steps += 1
            let before = vm.phase
            switch vm.phase {
            case .pointIntro:   vm.arrivedAtPoint()
            case .mission:      solve(vm)
            case .stepFeedback: vm.afterStepFeedback()
            case .discovery:    vm.afterDiscovery()
            case .story:        vm.afterStory()
            case .finalStage:   vm.submitFinal(correctAnswer(vm.play.final!.step))
            case .clear:        break
            }
            // FINAL 화면으로 새로 들어온 횟수 — 오답으로 머무는 건 세지 않는다.
            if vm.phase == .finalStage && before != .finalStage { finalShown += 1 }
        }
        return (finalShown, steps)
    }

    func test_성읍을_정답으로_끝까지_풀면_CLEAR_에_닿는다() throws {
        let play = try loadSeongeup()
        XCTAssertNotNil(play.final, "성읍은 FINAL 이 있는 PLAY 다")
        let vm = RunnerViewModel(play: play)

        let run = playThrough(vm) { vm in vm.submit(self.correctAnswer(vm.currentStep!)) }

        XCTAssertEqual(vm.phase, .clear, "끝까지 풀었는데 CLEAR 에 닿지 못했다 (\(run.steps)번 눌렀다)")
        XCTAssertEqual(run.finalShown, 1, "FINAL 이 한 번 이상 떴다 — 맞힌 뒤 FINAL 로 되돌아간다")
        XCTAssertEqual(Set(vm.progress.completedMissionIds), Set(play.orderedMissions.map(\.mission.id)))
        XCTAssertTrue(vm.progress.finalCleared)
        // 홈 카드가 「다시 하기」로 바뀌는 근거 — 저장소에도 CLEAR 로 남아야 한다.
        XCTAssertEqual(PlayProgressStore.shared.load(playId: play.id)?.isFinished, true)
    }

    func test_미션을_전부_건너뛰어도_CLEAR_에_닿는다() throws {
        let play = try loadSeongeup()
        let vm = RunnerViewModel(play: play)

        let run = playThrough(vm) { vm in vm.skipMission() }

        XCTAssertEqual(vm.phase, .clear, "건너뛰기만 해도 막히지 않아야 한다 (\(run.steps)번 눌렀다)")
        XCTAssertEqual(run.finalShown, 1)
        XCTAssertEqual(PlayProgressStore.shared.load(playId: play.id)?.isFinished, true)
    }
}
