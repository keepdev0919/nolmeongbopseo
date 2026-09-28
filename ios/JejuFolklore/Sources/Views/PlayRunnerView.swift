import SwiftUI
import UIKit
import CoreLocation

/// 현장 진행 화면 — PLAY 를 실제로 하는 곳.
///
///     Point 도착 → Mission → Step 1..N → Discovery → Story → 다음 → FINAL → CLEAR
///
/// ## 지키는 것
///
/// - **GPS 는 정답 판정기가 아니다.** 거리를 보여줄 뿐이고, 진행은 `[도착했어요]` 가 한다.
///   성읍은 Point 사이가 52m 라 GPS(±10~30m)로는 구분할 수 없다.
/// - **위치 권한이 없어도 끝까지 갈 수 있다.** 거리 줄이 안 뜰 뿐이다.
/// - **Mission 하나 때문에 관광이 막히지 않는다.** 힌트 2단계 → 건너뛰기가 항상 있다.
/// - **못 찾는 것과 없는 것은 다르다.** 현장이 자료와 다르면 신고할 수 있다 —
///   현장 답사를 하지 않기로 했으므로(2026-09-02) 이 경로가 콘텐츠 QA 의 눈이다.
struct PlayRunnerView: View {
    let play: Play

    @StateObject private var vm: RunnerViewModel
    @StateObject private var location = LocationService.shared
    @StateObject private var audio = StoryAudioPlayer.shared
    @Environment(\.dismiss) private var dismiss

    @State private var showQuit = false
    @State private var showReport = false
    // 진행 지도 시트는 2026-09-11 에 HUD 에서 내려갔다 (그 자리가 소리 스위치가 됨).
    // `ProgressMapSheet` 자체는 남겨 두었다 — 다른 자리에 다시 붙일 수 있다.
    /// 곱딱이가 말을 다 했는지. 미션 칸을 언제 띄울지 이걸로 정한다.
    @State private var speechDone = false
    /// 소리를 기다리다 너무 오래 걸리면 글자를 먼저 내보낸다 (2.5초).
    @State private var speechGateTimedOut = false
    @State private var gateTimer: Task<Void, Never>?

    init(play: Play) {
        self.play = play
        _vm = StateObject(wrappedValue: RunnerViewModel(play: play))
    }

    /// 화자 이름. **곱딱이** (2026-09-03 조익준님 결정).
    /// 초상화는 앱 아이콘의 픽셀 감귤이다.
    private static let speaker = "곱딱이"

    var body: some View {
        VStack(spacing: 0) {
            topHUD
            // 내용이 짧으면 아래에 붙어 있고, 길면(미션 보기 3개·긴 이야기)
            // 이 안에서 스크롤한다. 대화상자를 화면 위로 키우지 않는다.
            //
            // ⚠️ `.defaultScrollAnchor(.bottom)` 만으로는 안 됐다(2026-09-07 확인).
            // 짧은 내용이 이 앵커를 안 타고 위에 붙어 배경 그림만 아래로 길게
            // 남았다 — 미션 화면(내용이 짧다)마다 매번 이랬다. `GeometryReader`
            // 로 실제 여백 높이를 재서 `frame(minHeight:alignment: .bottom)` 으로
            // 직접 밀어붙이는 쪽이 이 SwiftUI 버전에서 더 확실하다.
            GeometryReader { geo in
                ScrollView {
                    sceneBottom
                        .frame(minHeight: geo.size.height, alignment: .bottom)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        // 배경은 `.background` 로 깐다 — ZStack 형제로 두면 그림이 화면 크기를
        // 정해 버려서 위에 얹은 것들이 밖으로 밀려난다.
        .background { PixelSceneBackground(imageName: play.placeKey) }
        .confirmationDialog("퀘스트를 그만할까요?", isPresented: $showQuit,
                            titleVisibility: .visible) {
            // 미션 단위로 저장한다 — 완료한 미션까지는 남고, 지금 풀던 미션의
            // Step·힌트는 사라진다. 「저장돼요」라고만 쓰면 과장이라 정도를 밝힌다.
            Button("나가기 (완료한 지점까지 저장돼요)", role: .destructive) { dismiss() }
            Button("계속하기", role: .cancel) {}
        }
        .sheet(isPresented: $showReport) {
            MissionReportSheet(
                playId: play.id,
                playTitle: play.title,
                missionId: vm.currentMission?.id ?? play.final?.id ?? "",
                missionTitle: vm.currentMission?.title ?? play.final?.title ?? ""
            ) { showReport = false }
        }
        .onAppear {
            location.requestCurrentLocationOnce()
            // 지난번에 못 보낸 신고가 있으면 지금 보낸다.
            Task { await MissionReportStore.shared.flush() }
        }
        .onDisappear { audio.stop() }
    }

    // MARK: - 상단 HUD

    /// 배경 위에 떠 있는 세 칸 — 나가기 · 진행도 · 소리 스위치.
    ///
    /// **진행 지도가 여기 있다** (2026-09-03 조익준님 결정, 2026-09-07 외부
    /// 길찾기에서 자체 지도로 교체). 전에는 이 자리가 외부 지도 앱 길찾기였다 —
    /// Point 4개가 이제 다 좌표를 갖고 있어(성읍 답사 완료) 자체 지도로도
    /// "몇 번째까지 왔는지"를 보여줄 수 있게 됐고, 그게 길찾기보다 이 화면에
    /// 더 필요한 정보였다. START(무료공영주차장)만 좌표가 없는데, 이름으로
    /// 찾을 수 있는 공공장소라 정밀 길찾기가 없어도 크게 아쉽지 않다.
    ///
    /// **나가기 아이콘은 화살표(←)가 아니라 X다** (2026-09-07 결정). 이 화면은
    /// `.fullScreenCover`로 띄운 모달이다 — 애플 HIG 기준 화살표는 NavigationStack
    /// 계층 이동(뒤로 가기)에, X는 모달 닫기에 쓴다. 화살표를 쓰면 "이전 미션으로
    /// 돌아간다"는 기대를 주는데 실제로는 PLAY 전체를 나가는 동작이라 어긋났다.
    private var topHUD: some View {
        HStack(spacing: PixelSpacing.s) {
            PixelHudButton(glyph: .close, label: "나가기") { showQuit = true }
            Spacer(minLength: 0)
            PixelHudProgress(
                label: play.progressLabel.isEmpty ? "진행" : play.progressLabel,
                total: play.progressRecords.count,
                done: vm.progress.discoveredRecordIds.count)
            Spacer(minLength: 0)
            // 오른쪽 칸은 **소리 스위치** (2026-09-11 조익준님 결정). 곱딱이 대사가
            // 단계마다 자동으로 읽히고, 원치 않으면 여기서 끈다. 전에는 진행 지도가
            // 이 자리였고 소리 버튼은 말풍선 안에 있었는데, 미션 하나를 풀어야 처음
            // 만나는 버튼이라 있는 줄 모르기 쉬웠다.
            PixelHudButton(glyph: audio.isMuted ? .soundOff : .sound,
                           label: audio.isMuted ? "소리 켜기" : "소리 끄기") {
                audio.setMuted(!audio.isMuted)
                if !audio.isMuted { speakCurrentLine() }
            }
        }
        .padding(.horizontal, PixelSpacing.xl)
        .padding(.top, PixelSpacing.s)
    }

    // MARK: - 아래 (정보판 + 말풍선 + 버튼)

    /// **대화창에는 곱딱이가 말하는 것만 넣는다** (2026-09-04 조익준님 결정).
    ///
    ///     [ 배지 ]        자기 색이 채워져 있어 그림 위에 그냥 둬도 읽힌다
    ///     ┌ 정보판 ┐      나머지 전부. 가라앉은 바탕 · 2px 테두리
    ///     ┌ 대화창 ┐      초상화 · 이름 · 대사 · ▼. 흰 바탕 · 4px · 귀퉁이 점
    ///     [ 버튼 ]
    ///
    /// 전에는 단계마다 대화창 안에 든 것이 달라서 크기가 들쭉날쭉했다. 곱딱이
    /// 목소리만 남기면 **대화창은 언제나 같은 모양**이고, 바뀌는 것은 그 위다.
    ///
    /// 글자가 있는 것은 반드시 상자에 담는다 — 배경 그림 위에 그냥 얹으면
    /// 하늘에서는 읽히고 돌담에서는 사라진다.
    private var sceneBottom: some View {
        VStack(alignment: .leading, spacing: PixelSpacing.m) {
            if showsTask { infoSection }
            PixelDialogueBox(showsNext: waitsForSpeech ? !speechDone : true) {
                VStack(alignment: .leading, spacing: PixelSpacing.m) {
                    speechSection
                }
            }
            if showsTask { actionRow }
        }
        // 말이 바뀌면 다시 기다린다. 대장간집 미션은 Step 이 둘이라 두 번째
        // 질문도 곱딱이가 말하고 나서 보기가 뜬다.
        .onChange(of: speechKey) {
            speechDone = false
            speakCurrentLine()
        }
        .onAppear { speakCurrentLine() }
        .onDisappear { gateTimer?.cancel() }
        .padding(.horizontal, PixelSpacing.l)
        .padding(.top, PixelSpacing.xl)
        .padding(.bottom, PixelSpacing.xl)
    }

    /// **곱딱이 말이 끝난 뒤에 위 칸이 나타나는 단계**
    /// (2026-09-04 조익준님 결정).
    ///
    /// 말하는 중에 보기 버튼이 이미 떠 있으면 눈이 두 곳으로 갈려서, 글을 다
    /// 안 읽고 누르게 된다. 기다리는 동안에는 `▼` 가 깜빡여 「누르면 다 나온다」를
    /// 알려주고, 말이 끝나면 `▼` 가 사라지며 칸이 나타난다.
    ///
    /// 미션·FINAL 은 **답을 넣어야 해서** 그렇고, 발견은 이유가 다르다 —
    /// 곱딱이가 무엇을 찾았는지 설명하는 동안 `NEW DISCOVERY` 배지가 이미 떠
    /// 있으면 **상이 설명보다 먼저 온다.** 설명이 끝나고 나서 배지가 떠야
    /// 「이래서 이걸 찾은 거였구나」가 된다.
    ///
    /// 가는 중·이야기·CLEAR 는 그대로 같이 띄운다 — 그쪽 위 칸은 목적지 이름이나
    /// 제목·참고자료·통계라서 곱딱이 말과 **같이 봐야** 이해된다.
    private var waitsForSpeech: Bool {
        vm.phase == .mission || vm.phase == .finalStage || vm.phase == .discovery
    }

    private var showsTask: Bool { !waitsForSpeech || speechDone }

    /// 말이 바뀌었는지 알아보는 열쇠. 단계·미션·Step 중 하나만 바뀌어도 달라진다.
    private var speechKey: String {
        "\(vm.phase)-\(vm.currentMission?.id ?? "")-\(vm.stepIndex)"
    }

    /// 대화창 **위** — 곱딱이 말이 아닌 모든 것.
    @ViewBuilder
    private var infoSection: some View {
        switch vm.phase {
        case .pointIntro:   pointIntroInfo
        case .mission:      missionInfo
        case .stepFeedback: stepFeedbackInfo
        case .discovery:    discoveryInfo
        case .story:        storyInfo
        case .finalStage:   finalInfo
        case .clear:        clearInfo
        }
    }

    /// 대화창 **안** — 곱딱이가 말하는 것.
    @ViewBuilder
    private var speechSection: some View {
        switch vm.phase {
        case .pointIntro:
            if let point = vm.currentPoint {
                speech(point.navigationText.isEmpty ? point.objective : point.navigationText)
            }
        case .mission:
            if let mission = vm.currentMission, let step = vm.currentStep {
                speech(missionSpeech(mission, step))
            }
        case .stepFeedback:
            if let text = vm.pendingSuccess { speech(text) }
        case .discovery:
            if let d = vm.pendingDiscovery { speech(d.body) }
        case .story:
            if let story = vm.pendingStory { speech(story.script, story: story) }
        case .finalStage:
            if let final = play.final { speech(final.prompt) }
        case .clear:
            if let body = play.clear?.body, !body.isEmpty { speech(body) }
        }
    }

    /// 정보판의 겉모양. 대화창과 **일부러 다르게** 한다 —
    /// 테두리가 얇고(2px), 바탕이 가라앉았고, 귀퉁이 점이 없다.
    private func infoFrame<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: PixelSpacing.m) {
            content()
        }
        .padding(PixelSpacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PixelColor.surfaceLow)
        .pixelBorder(width: PixelSpacing.border)
        .pixelShadow(PixelSpacing.shadowCard)
    }

    /// 곱딱이가 말하는 줄 — 초상화 · 이름 · 한 글자씩 나타나는 글.
    ///
    /// 소리는 여기 없다 — 단계가 바뀌면 자동으로 읽히고 상단 HUD 에서 끈다
    /// (2026-09-11). `story` 는 출처 표기를 위해서만 받는다.
    ///
    /// **출처 표시는 대화상자 안, 우측 하단에 작게 붙인다** (2026-09-07 결정).
    /// 한국관광공사 OpenAPI(공공누리)는 가공해서 쓰더라도 출처표시가 공통
    /// 필수 조건이라 없앨 수 없다 — 대신 눈에 덜 띄게 자리만 옮겼다. 캐릭터
    /// 이름이 아니라 사실 정보라서 곱딱이 말풍선 타자기 효과 밖에, 조용한
    /// 글자로 둔다. 관광공사 관련 출처가 없는 Story(예: 국가유산·학술자료만
    /// 쓴 곳)에는 아무것도 안 뜬다 — 법적 의무가 없는 출처까지 화면에
    /// 늘어놓지 않는다.
    @ViewBuilder
    private func speech(_ text: String, story: PlayStory? = nil) -> some View {
        HStack(alignment: .top, spacing: PixelSpacing.l) {
            PixelPortrait()
            VStack(alignment: .leading, spacing: PixelSpacing.s) {
                Text(Self.speaker)
                    .font(PixelFont.label)
                    .foregroundStyle(PixelColor.primary)
                    .tracking(2)
                PixelTypewriter(text: text, isFinished: $speechDone, isReady: speechReady)
                if let story, let ref = ktoSourceLabel(story) {
                    Text(ref)
                        .font(PixelFont.labelSmall)
                        .foregroundStyle(PixelColor.inkWeak)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
    }

    /// 한국관광공사(오디) 출처만 골라 표시 문구를 만든다. 없으면 nil.
    private func ktoSourceLabel(_ story: PlayStory) -> String? {
        guard let s = story.sources.first(where: { $0.kind == "odii" || $0.kind == "kto" })
        else { return nil }
        return sourceLabel(s)
    }

    /// 지금 화면의 곱딱이 대사를 가리키는 열쇠. 서버 `resolve_line` 과 같은 형식이다 —
    /// 문장을 보내지 않고 열쇠만 보낸다.
    private var currentLine: String? {
        switch vm.phase {
        case .pointIntro:
            return vm.currentPoint.map { "point:\($0.id)" }
        case .mission:
            return vm.currentMission.map { "mission:\($0.id):\(vm.stepIndex)" }
        case .stepFeedback:
            guard vm.pendingSuccess != nil, let m = vm.currentMission else { return nil }
            return "feedback:\(m.id):\(vm.stepIndex)"
        case .discovery:
            guard vm.pendingDiscovery != nil, let m = vm.currentMission else { return nil }
            return "discovery:\(m.id)"
        case .story:
            return vm.pendingStory.map { "story:\($0.id)" }
        case .finalStage:
            return play.final == nil ? nil : "final"
        case .clear:
            return (play.clear?.body.isEmpty == false) ? "clear" : nil
        }
    }

    /// 지금 대사를 읽고, 그 다음 두 줄을 미리 받아 둔다. 음소거면 `audio` 가 재생만 건너뛴다.
    private func speakCurrentLine() {
        speechGateTimedOut = false
        gateTimer?.cancel()
        gateTimer = Task { [self] in
            try? await Task.sleep(for: .milliseconds(2500))
            if !Task.isCancelled { speechGateTimedOut = true }
        }
        guard let line = currentLine else { return }
        audio.play(playId: play.id, line: line)
        let order = speechOrder
        if let i = order.firstIndex(of: line) {
            for next in order.dropFirst(i + 1).prefix(2) {
                audio.prefetch(playId: play.id, line: next)
            }
        }
    }

    /// **글자는 소리와 함께 출발한다** (2026-09-11 조익준님 지적). 소리가 준비되면,
    /// 소리가 꺼져 있으면, 소리를 못 불러오면, 2.5초가 지나면 글자를 내보낸다.
    private var speechReady: Bool {
        guard let line = currentLine else { return true }
        if audio.isMuted || speechGateTimedOut { return true }
        guard audio.currentLine == line else { return false }
        return audio.state == .playing || audio.state == .failed
    }

    /// 곱딱이 대사가 나올 순서. 미리 받아 둘 때 쓴다. 서버 `resolve_line` 열쇠 형식.
    private var speechOrder: [String] {
        var order: [String] = []
        for point in play.points {
            order.append("point:\(point.id)")
            for mission in point.missions {
                for (i, step) in mission.steps.enumerated() {
                    order.append("mission:\(mission.id):\(i)")
                    if !step.successFeedback.isEmpty { order.append("feedback:\(mission.id):\(i)") }
                }
                if let d = mission.discovery, !d.body.isEmpty { order.append("discovery:\(mission.id)") }
                if let story = play.stories.first(where: { $0.unlockAfterMission == mission.id }) {
                    order.append("story:\(story.id)")
                }
            }
        }
        if let final = play.final {
            order.append("final")
            if let story = final.story { order.append("story:\(story.id)") }
        }
        if play.clear?.body.isEmpty == false { order.append("clear") }
        return order
    }

    // MARK: - 「가는 중」 정보판

    /// **도착한 뒤가 아니라 아직 안 갔을 때** 뜨는 화면이다.
    /// 「대장간집으로 가세요」 → 걸어가서 → `[도착했어요]`.
    @ViewBuilder
    private var pointIntroInfo: some View {
        if let point = vm.currentPoint {
            infoFrame {
                HStack {
                    Text("POINT \(vm.pointNumber) / \(play.points.count)")
                        .font(PixelFont.labelSmall)
                        .foregroundStyle(PixelColor.inkWeak)
                    Spacer(minLength: 0)
                    distanceRow(to: point)
                }
                Text(point.title)
                    .font(PixelFont.sectionTitle)
                    .foregroundStyle(PixelColor.ink)
                if !point.navigationText.isEmpty, !point.objective.isEmpty {
                    Text(point.objective)
                        .font(PixelFont.body)
                        .foregroundStyle(PixelColor.inkWeak)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// 거리 한 줄. **위치를 못 잡으면 그냥 안 뜬다** — 진행을 막지 않는다.
    @ViewBuilder
    private func distanceRow(to point: PlayPoint) -> some View {
        if let here = location.currentLocation, let c = point.coordinate {
            let meters = here.distance(from: CLLocation(latitude: c.latitude,
                                                        longitude: c.longitude))
            HStack(spacing: PixelSpacing.xs) {
                PixelIcon(.target, size: 14, color: PixelColor.primary)
                Text(meters < 1000
                     ? String(format: "약 %.0fm", meters)
                     : String(format: "약 %.1fkm", meters / 1000))
                    .font(PixelFont.labelSmall)
                    .foregroundStyle(PixelColor.primary)
            }
        }
    }

    // MARK: - Mission 정보판

    /// ⚠️ 미션 화면은 시안(3)을 그대로 못 쓴다. 시안은 「읽고 → 다음」 한 장면인데
    /// 미션은 **답을 넣어야** 한다 (보기 고르기 8 · 확인 3 · 방향 1).
    /// 미션 전용 시안이 오면 다시 짠다.
    @ViewBuilder
    private var missionInfo: some View {
        if let mission = vm.currentMission, let step = vm.currentStep {
            infoFrame {
                HStack {
                    Text(vm.currentPoint?.title ?? "")
                        .font(PixelFont.labelSmall)
                        .foregroundStyle(PixelColor.inkWeak)
                    Spacer(minLength: 0)
                    Text("MISSION")
                        .font(PixelFont.labelSmall)
                        .foregroundStyle(PixelColor.inkWeak)
                }
                Text(mission.title)
                    .font(PixelFont.sectionTitle)
                    .foregroundStyle(PixelColor.ink)

                if let wrong = vm.wrongMessage {
                    HStack(alignment: .top, spacing: PixelSpacing.s) {
                        PixelIcon(.refresh, size: 16, color: PixelColor.locked)
                        Text(wrong)
                            .font(PixelFont.body)
                            .foregroundStyle(PixelColor.locked)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(PixelSpacing.m)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PixelColor.surface)
                    .pixelBorder()
                }

                MissionStepInput(step: step) { vm.submit($0) }
                revealedHints(mission.hints)
                escapeRow(mission)
            }
        }
    }

    /// 맞혔을 때 — 어느 미션을 맞혔는지만 남기고, 칭찬은 곱딱이가 한다.
    @ViewBuilder
    private var stepFeedbackInfo: some View {
        if let mission = vm.currentMission {
            infoFrame {
                Text(mission.title)
                    .font(PixelFont.sectionTitle)
                    .foregroundStyle(PixelColor.ink)
            }
        }
    }

    /// 첫 Step 에서는 미션 안내 + 질문, 뒤 Step 은 질문만.
    /// **같은 글을 세 번 읽게 하면 현실을 볼 시간이 줄어든다.**
    private func missionSpeech(_ mission: Mission, _ step: MissionStep) -> String {
        if vm.stepIndex == 0, !mission.prompt.isEmpty {
            return step.prompt.isEmpty ? mission.prompt
                                       : mission.prompt + "\n\n" + step.prompt
        }
        return step.prompt.isEmpty ? mission.prompt : step.prompt
    }

    @ViewBuilder
    private func revealedHints(_ hints: [MissionHint]) -> some View {
        if vm.hintLevel > 0 {
            VStack(alignment: .leading, spacing: PixelSpacing.s) {
                ForEach(Array(hints.prefix(vm.hintLevel).enumerated()),
                        id: \.offset) { i, hint in
                    HStack(alignment: .top, spacing: PixelSpacing.s) {
                        Text("힌트 \(i + 1)")
                            .font(PixelFont.labelSmall)
                            .foregroundStyle(PixelColor.onAccent)
                            .padding(.horizontal, PixelSpacing.xs)
                            .padding(.vertical, 2)
                            .background(PixelColor.accent)
                        Text(hint.text)
                            .font(PixelFont.body)
                            .foregroundStyle(PixelColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(PixelSpacing.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PixelColor.surface)
            .pixelBorder()
        }
    }

    /// **막히면 나갈 길이 항상 있다.** 미션 하나 때문에 관광이 멈추지 않는다.
    ///
    /// 정보판 **안**에 둔다 — 밖은 배경 그림 위라 작은 글자가 안 읽힌다.
    ///
    /// ## `정답과 이야기 보기` 는 힌트를 다 본 뒤에만 나온다
    ///
    /// 2026-09-04 조익준님 결정. 이 버튼은 답을 못 맞혀도 발견·이야기를 열고
    /// 다음으로 넘어간다 (진행도 칸도 채워지지만 「건너뛴 미션」으로 따로 세어
    /// CLEAR 에서 구분한다).
    ///
    /// 전에는 보기 버튼 바로 아래에 **처음부터** 있었다. 그러면 한 번도 안
    /// 풀어본 사람이 그냥 눌러서, 현실을 보고 발견하는 경험이 글 읽기로
    /// 바뀐다 — 성읍의 대표 미션(호령창)도 그렇게 넘어갈 수 있었다.
    ///
    /// 힌트를 다 본 뒤에 열면 「막히면 안 갇힌다」(CLAUDE.md)는 지키면서 답을
    /// 먼저 보는 길만 한 칸 뒤로 미룬다. 힌트가 없는 미션은 바로 열린다 —
    /// 열어 볼 힌트가 없는데 막아두면 갇힌다.
    ///
    /// `현장에서 찾을 수 없어요` 는 **항상** 있다. 콘텐츠 신고이고, 현장 답사를
    /// 하지 않기로 했으므로(2026-09-02) 이 경로가 콘텐츠 QA 의 눈이다.
    private func escapeRow(_ mission: Mission) -> some View {
        HStack(spacing: PixelSpacing.l) {
            if vm.hintLevel >= mission.hints.count {
                Button("정답과 이야기 보기") { vm.skipMission() }
            }
            Button("현장에서 찾을 수 없어요") { showReport = true }
            Spacer(minLength: 0)
        }
        .font(PixelFont.labelSmall)
        .foregroundStyle(PixelColor.inkWeak)
        .buttonStyle(.plain)
    }

    // MARK: - Discovery 정보판

    @ViewBuilder
    private var discoveryInfo: some View {
        if let d = vm.pendingDiscovery {
            sceneBadge(vm.lastSkipped ? "정답" : "NEW DISCOVERY",
                       fill: PixelColor.accent, label: PixelColor.onAccent)
            // 제목은 이름 있는 사물(정주석·물팡·호령창)에만 있다.
            // 없는 발견은 본문만 보여준다 — 없는 이름을 지어내지 않는다.
            if !d.title.isEmpty || vm.justEarnedRecord != nil {
                infoFrame {
                    if !d.title.isEmpty {
                        Text(d.title)
                            .font(PixelFont.sectionTitle)
                            .foregroundStyle(PixelColor.ink)
                    }
                    if let record = vm.justEarnedRecord {
                        HStack(spacing: PixelSpacing.s) {
                            PixelIcon(.check, size: 18, color: PixelColor.primary)
                            Text("\(record) 기록 복원")
                                .font(PixelFont.label)
                                .foregroundStyle(PixelColor.ink)
                        }
                        .padding(PixelSpacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(PixelColor.surface)
                        .pixelBorder()
                    }
                }
            }
        }
    }

    // MARK: - Story 정보판

    /// 발견 뒤에 오는 의미. **놀멍봅서가 직접 쓴 문장이다** — 오디 대본이 아니다.
    ///
    /// 소리는 상단 HUD 스피커 하나가 맡는다 — 단계가 바뀌면 자동 재생 (2026-09-11).
    ///
    /// **참고 자료 목록은 여기서 뺐다** (2026-09-07 결정). 국가유산·학술자료
    /// 출처는 콘텐츠 검증용으로 `콘텐츠/성읍민속마을.md` 에만 남기고 화면에는
    /// 안 보여준다 — 법적 의무가 없는 출처를 화면에 늘어놓을 이유가 없다.
    /// 법적 의무가 있는 관광공사 출처만 `speech()` 쪽 대화상자 귀퉁이에
    /// 작게 남았다.
    @ViewBuilder
    private var storyInfo: some View {
        if let story = vm.pendingStory, !story.title.isEmpty {
            infoFrame {
                Text(story.title)
                    .font(PixelFont.sectionTitle)
                    .foregroundStyle(PixelColor.ink)
            }
        }
    }

    /// 출처 한 줄. 공지가 지정한 형식은 텍스트만 허용한다 — 로고·CI 는 금지다.
    private func sourceLabel(_ s: StorySource) -> String {
        switch s.kind {
        case "odii", "kto": return "출처: ⓒ한국관광공사" + (s.ref.isEmpty ? "" : " (\(s.ref))")
        case "encykorea":   return "한국민족문화대백과사전 \(s.ref)"
        case "heritage":    return "국가유산 공식자료 \(s.ref)"
        default:            return s.ref.isEmpty ? s.kind : "\(s.kind) \(s.ref)"
        }
    }

    // MARK: - FINAL 정보판

    @ViewBuilder
    private var finalInfo: some View {
        if let final = play.final {
            sceneBadge("FINAL", fill: PixelColor.primary, label: PixelColor.onPrimary)
            infoFrame {
                Text(final.title)
                    .font(PixelFont.sectionTitle)
                    .foregroundStyle(PixelColor.ink)
                if let wrong = vm.wrongMessage {
                    Text(wrong)
                        .font(PixelFont.body)
                        .foregroundStyle(PixelColor.locked)
                        .fixedSize(horizontal: false, vertical: true)
                }
                MissionStepInput(step: final.step) { vm.submitFinal($0) }
                revealedHints(final.hints)
            }
        }
    }

    // MARK: - CLEAR 정보판

    @ViewBuilder
    private var clearInfo: some View {
        sceneBadge("CLEAR", fill: PixelColor.primary, label: PixelColor.onPrimary)
        infoFrame {
            Text(play.clear?.title ?? play.title)
                .font(PixelFont.sectionTitle)
                .foregroundStyle(PixelColor.ink)
            HStack(spacing: PixelSpacing.m) {
                statBox("\(vm.progress.completedMissionIds.count) / \(play.missionCount)", "완료 미션")
                if !vm.progress.skippedMissionIds.isEmpty {
                    statBox("\(vm.progress.skippedMissionIds.count)", "건너뛴 미션")
                }
                statBox(vm.elapsedText, "걸린 시간")
            }
        }
    }

    private func statBox(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(PixelFont.label).foregroundStyle(PixelColor.ink)
            Text(label).font(PixelFont.labelSmall).foregroundStyle(PixelColor.inkWeak)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, PixelSpacing.s)
        .background(PixelColor.surface)
        .pixelBorder()
    }

    private func sceneBadge(_ text: String, fill: Color, label: Color) -> some View {
        Text(text)
            .font(PixelFont.labelSmall)
            .foregroundStyle(label)
            .padding(.horizontal, PixelSpacing.s)
            .padding(.vertical, PixelSpacing.xs)
            .background(fill)
            .pixelBorder()
            .pixelShadow(PixelSpacing.shadowSmall)
    }

    // MARK: - 아래 버튼

    /// 시안: 가로 두 칸. 단계마다 하나만 필요하면 **한 칸이 폭을 다 쓴다** —
    /// 억지로 뭘 채워 넣지 않는다.
    @ViewBuilder
    private var actionRow: some View {
        switch vm.phase {
        case .pointIntro:
            sceneButton("도착했어요", filled: true) { vm.arrivedAtPoint() }
        case .mission:
            if let mission = vm.currentMission, vm.hintLevel < mission.hints.count {
                sceneButton(vm.hintLevel == 0 ? "힌트 보기" : "힌트 하나 더",
                            filled: false) { vm.showNextHint() }
            }
        case .stepFeedback:
            sceneButton("계속", filled: true) { vm.afterStepFeedback() }
        case .discovery:
            sceneButton("계속", filled: true) { vm.afterDiscovery() }
        case .story:
            sceneButton(vm.isLastMission ? "마지막으로" : "다음", filled: true) {
                // 다음 화면으로 넘어가면 소리를 끊는다. 미션 화면에서 앞
                // 이야기가 계속 흐르면 현실을 보는 데 방해가 된다.
                audio.stop()
                vm.afterStory()
            }
        case .finalStage:
            // FINAL 은 720가지(6!) 순서 중 하나를 맞혀야 해서 다른 미션보다
            // 막히기 쉽다 — 그래서 여기도 힌트 2단계를 준다(2026-09-07).
            if let hints = play.final?.hints, vm.hintLevel < hints.count {
                sceneButton(vm.hintLevel == 0 ? "힌트 보기" : "힌트 하나 더",
                            filled: false) { vm.showNextFinalHint() }
            }
            #if DEBUG
            // 개발 중 확인용. 6개짜리 순서 세우기는 720가지라 앞뒤 화면을 볼 때마다
            // 다시 맞히기가 번거롭다 (2026-09-10 조익준님 요청).
            //
            // ⚠️ `#if DEBUG` 를 벗기지 말 것. 배포 빌드에 나가면 「현실을 보고
            // 발견한다」는 이 앱의 전부가 버튼 한 번으로 사라진다.
            sceneButton("🐞 바로 통과", filled: false) { vm.debugPassFinal() }
            #endif
        case .clear:
            sceneButton("PLAY 종료", filled: true) { dismiss() }
        }
    }

    private func sceneButton(_ title: String, filled: Bool,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(PixelFont.sectionTitle)                 // 시안 headline-md 24
                .foregroundStyle(filled ? PixelColor.onPrimary : PixelColor.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
                .padding(.vertical, PixelSpacing.m)           // p-3
                .background(filled ? PixelColor.primary : PixelColor.surfaceMid)
                .pixelBorder(width: PixelSpacing.border)
        }
        .buttonStyle(PixelPressStyle())
    }
}

// MARK: - 진행 지도 시트

/// 러너 안에서 보는 진행 지도. **외부 지도 길찾기를 대체한다** (2026-09-07 결정).
/// Point 4개는 이제 다 좌표가 있어 자체 지도로도 위치를 보여줄 수 있고, 클리어한
/// 곳은 체크로 표시해 "몇 번째까지 왔는지"도 같이 보여준다. `PlayDetailView` 의
/// 경로 안내와 같은 `PlayRouteMap`·`RouteListRow` 를 그대로 쓴다.
private struct ProgressMapSheet: View {
    let play: Play
    let clearedPointIds: Set<String>
    let isFinished: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: PixelSpacing.m) {
                    PlayRouteMap(play: play)
                        .frame(height: 220)
                        .pixelBorder(width: PixelSpacing.border)
                    VStack(spacing: PixelSpacing.s) {
                        // 시작은 러너에 들어온 시점에 이미 지난 일이라 항상 완료로 본다.
                        RouteListRow(marker: "START", text: play.startName,
                                     kind: .terminal, done: true)
                        ForEach(Array(play.points.enumerated()), id: \.element.id) { i, point in
                            RouteListRow(marker: "\(i + 1)", text: point.title, kind: .step,
                                         done: clearedPointIds.contains(point.id))
                        }
                        RouteListRow(marker: "FINISH", text: play.finishName,
                                     kind: .terminal, done: isFinished)
                    }
                }
                .padding(PixelSpacing.l)
            }
            .background(PixelColor.background)
            .navigationTitle("진행 지도")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }
}

// MARK: - 뷰모델

@MainActor
final class RunnerViewModel: ObservableObject {

    enum Phase { case pointIntro, mission, stepFeedback, discovery, story, finalStage, clear }

    @Published private(set) var phase: Phase = .pointIntro
    @Published private(set) var missionIndex = 0
    @Published private(set) var stepIndex = 0
    @Published private(set) var hintLevel = 0
    @Published private(set) var wrongMessage: String?
    /// 맞혔을 때 곱딱이가 해 주는 말. 원고가 적어 둔 Step 에만 있다.
    @Published private(set) var pendingSuccess: String?
    @Published private(set) var pendingDiscovery: MissionDiscovery?
    @Published private(set) var pendingStory: PlayStory?
    @Published private(set) var justEarnedRecord: String?
    @Published private(set) var lastSkipped = false
    @Published private(set) var progress: PlayProgress

    let play: Play
    private var flat: [(point: PlayPoint, mission: Mission)]
    /// 이미 안내를 마친 Point. 같은 Point 의 두 번째 미션에서 또 도착 화면을 띄우지 않는다.
    private var introducedPointIds: Set<String> = []

    /// **저장된 진행이 있으면 이어받는다** (2026-09-07 되살림, `PlayProgress` 주석 참조).
    ///
    /// 이미 CLEAR 한 기록은 이어받지 않는다 — 「다시 하기」는 처음부터가 맞다.
    /// 이어받을 때는 **완료한 미션 다음**에서 시작한다. 지금 하던 미션의 Step·힌트는
    /// 저장하지 않으므로 그 미션은 처음부터 다시 푼다.
    init(play: Play) {
        self.play = play
        self.flat = play.orderedMissions

        if let saved = PlayProgressStore.shared.load(playId: play.id), !saved.isFinished {
            self.progress = saved
            self.missionIndex = flat.firstIndex { !saved.completedMissionIds.contains($0.mission.id) }
                ?? max(flat.count - 1, 0)
        } else {
            self.progress = PlayProgress(play: play)
        }
    }

    // MARK: 조회

    var currentPoint: PlayPoint? { flat[safe: missionIndex]?.point }
    var currentMission: Mission? { flat[safe: missionIndex]?.mission }
    var currentStep: MissionStep? { currentMission?.steps[safe: stepIndex] }
    var isLastMission: Bool { missionIndex >= flat.count - 1 }

    var pointNumber: Int {
        guard let p = currentPoint else { return 1 }
        return (play.points.firstIndex { $0.id == p.id } ?? 0) + 1
    }

    /// 진행 지도가 체크 표시를 넣을 Point id 들 — 그 Point 의 미션을 전부 끝냈을 때.
    var clearedPointIds: Set<String> {
        Set(play.points.filter { pt in
            !pt.missions.isEmpty
                && pt.missions.allSatisfy { progress.completedMissionIds.contains($0.id) }
        }.map(\.id))
    }

    var navigationTitle: String {
        switch phase {
        case .clear: return "CLEAR"
        case .finalStage: return "FINAL"
        default: return play.title
        }
    }

    var elapsedText: String {
        let m = Int(Date().timeIntervalSince(progress.startedAt) / 60)
        return m < 60 ? "\(m)분" : "\(m / 60)시간 \(m % 60)분"
    }

    // MARK: 진행

    func arrivedAtPoint() {
        if let p = currentPoint { introducedPointIds.insert(p.id) }
        wrongMessage = nil
        phase = .mission
    }

    func showNextHint() {
        guard let m = currentMission else { return }
        hintLevel = min(hintLevel + 1, m.hints.count)
    }

    func showNextFinalHint() {
        guard let hints = play.final?.hints else { return }
        hintLevel = min(hintLevel + 1, hints.count)
    }

    func submit(_ answer: MissionAnswer) {
        guard let step = currentStep, let mission = currentMission else { return }
        guard step.isCorrect(answer) else {
            wrongMessage = step.failureText
            return
        }
        wrongMessage = nil
        // **맞혔다는 말을 삼키지 않는다** (2026-09-04). 발견이 없는 Step 은
        // 정답을 눌러도 다음 화면으로 툭 넘어가서 맞았는지 알 수 없었다.
        // 원고가 성공 문구를 적어 둔 Step 은 그 말을 먼저 듣고 넘어간다.
        if !step.successFeedback.isEmpty {
            pendingSuccess = step.successFeedback
            phase = .stepFeedback
            return
        }
        proceedAfterStep(mission)
    }

    /// 성공 문구를 읽고 [계속] 을 눌렀을 때.
    func afterStepFeedback() {
        pendingSuccess = nil
        guard let mission = currentMission else { return }
        proceedAfterStep(mission)
    }

    private func proceedAfterStep(_ mission: Mission) {
        if stepIndex + 1 < mission.steps.count {
            stepIndex += 1
            phase = .mission
        } else {
            completeMission(mission, skipped: false)
        }
    }

    /// 건너뛰기 — 정답과 이야기를 열고 계속 간다. **진행이 막히지 않는다.**
    func skipMission() {
        guard let mission = currentMission else { return }
        if !progress.skippedMissionIds.contains(mission.id) {
            progress.skippedMissionIds.append(mission.id)
        }
        completeMission(mission, skipped: true)
    }

    private func completeMission(_ mission: Mission, skipped: Bool) {
        lastSkipped = skipped
        if !progress.completedMissionIds.contains(mission.id) {
            progress.completedMissionIds.append(mission.id)
        }
        // 진행도 칸. 모든 미션이 칸을 채우지는 않는다 — 앞 미션이 뒤 미션의
        // 발견을 준비하는 경우가 있다 (콘텐츠.md §13).
        justEarnedRecord = nil
        pendingSuccess = nil
        if let reward = mission.progressReward,
           !progress.discoveredRecordIds.contains(reward) {
            progress.discoveredRecordIds.append(reward)
            justEarnedRecord = play.progressRecords.first { $0.id == reward }?.label
        }
        pendingDiscovery = mission.discovery
        pendingStory = play.story(after: mission.id)
        hintLevel = 0
        stepIndex = 0
        PlayProgressStore.shared.save(progress)

        // Discovery 가 없는 미션이 있다 — M01 처럼 다음 미션의 발견을 준비하는 것이다
        // (콘텐츠.md §13). 그때는 발견 화면을 건너뛰고 바로 다음으로 간다.
        if pendingDiscovery != nil {
            phase = .discovery
        } else if pendingStory != nil {
            phase = .story
        } else {
            advance()
        }
    }

    func afterDiscovery() {
        if pendingStory != nil { phase = .story } else { advance() }
    }

    func afterStory() { advance() }

    /// 다음 미션으로. 같은 Point 면 바로 미션, 다른 Point 면 도착 안내부터.
    private func advance() {
        pendingDiscovery = nil
        pendingStory = nil
        justEarnedRecord = nil

        if missionIndex + 1 < flat.count {
            missionIndex += 1
            stepIndex = 0
            hintLevel = 0
            let nextPoint = flat[missionIndex].point
            phase = introducedPointIds.contains(nextPoint.id) ? .mission : .pointIntro
        } else if play.final != nil {
            hintLevel = 0
            phase = .finalStage
        } else {
            finish()
        }
    }

    /// 틀렸을 때 "몇 개 중 몇 개는 맞았는지"를 먼저 말해준다 (2026-09-07).
    /// 6개짜리 순서 세우기는 한 번에 다 맞히기 어렵다 — 완전히 틀렸다와
    /// 거의 다 왔다를 구분해줘야 다시 시도할 힘이 난다.
    func submitFinal(_ answer: MissionAnswer) {
        guard let final = play.final else { finish(); return }
        guard final.step.isCorrect(answer) else {
            if let n = final.step.partialCorrectCount(answer) {
                let total = final.step.options.count
                wrongMessage = "\(total)개 중 \(n)개는 순서가 맞았어! " + final.step.failureText
            } else {
                wrongMessage = final.step.failureText
            }
            return
        }
        wrongMessage = nil
        if let story = final.story {
            pendingStory = story
            phase = .story
            return
        }
        finish()
    }

    #if DEBUG
    /// 개발 중 확인용 — 순서를 맞힌 것으로 치고 그대로 진행한다.
    /// 정답 경로와 **같은 길**을 탄다(이야기가 있으면 이야기부터). 그래야
    /// 이 버튼으로 넘어간 뒤에 보는 화면이 실제와 같다.
    func debugPassFinal() {
        wrongMessage = nil
        if let story = play.final?.story {
            pendingStory = story
            phase = .story
            return
        }
        finish()
    }
    #endif

    private func finish() {
        progress.finalCleared = true
        // CLEAR 기록을 남긴다 — 홈 카드가 「다시 하기」로 바뀌는 근거다.
        PlayProgressStore.shared.save(progress)
        phase = .clear
    }

}

// MARK: - 안전한 인덱스

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
