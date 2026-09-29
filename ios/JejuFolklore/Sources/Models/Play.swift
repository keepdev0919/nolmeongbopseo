import Foundation
import CoreLocation

/// PLAY 콘텐츠. 서버 `GET /plays/{id}` 가 내려준다.
///
/// 구조는 백엔드 `models/play.py` 와 같다.
///
///     PLAY → Point → Mission → Step
///
/// **Mission 하나 ≠ 화면 하나다.** 호령창은 `찾았어요 → 오른쪽 → 왜` 세 Step 이
/// 모여 하나다. 그래서 화면을 정하는 것은 `Step.inputType` 하나뿐이고,
/// `Mission.patterns`(FIND·COMPARE·INFER…)는 콘텐츠 검수용 이름표다.

// MARK: - 답

/// Step 의 정답. `inputType` 마다 모양이 다르다.
///
/// 서버가 JSON 으로 문자열·숫자·배열·null 을 섞어 보내므로 하나로 받아 둔다.
enum MissionAnswer: Equatable {
    case none                 // CONFIRM — 누르면 통과
    case text(String)         // CHOICE(보기 id) · DIRECTION(LEFT/RIGHT/…)
    case number(Int)          // NUMBER
    case list([String])       // SHORT_TEXT(허용 답안) · MATCH_ORDER(순서 또는 "a>x")
}

extension MissionAnswer: Decodable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .none; return }
        if let v = try? c.decode(Int.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .text(v); return }
        if let v = try? c.decode([String].self) { self = .list(v); return }
        self = .none
    }
}

// MARK: - Step

enum MissionInput: String, Decodable {
    case confirm = "CONFIRM"
    case choice = "CHOICE"
    case direction = "DIRECTION"
    case number = "NUMBER"
    case shortText = "SHORT_TEXT"
    case matchOrder = "MATCH_ORDER"
}

struct MissionOption: Decodable, Identifiable, Equatable, Hashable {
    let id: String
    let label: String
    /// 그림 보기. 배치도처럼 글자로 설명하기 어려운 것에만 쓴다.
    /// ⚠️ 미션의 답이 되는 **현실물**을 그림으로 대체하지 않는다.
    let image: String?
}

struct MissionStep: Decodable, Identifiable, Equatable {
    let inputType: MissionInput
    let prompt: String
    let options: [MissionOption]
    /// 짝 맞추기의 오른쪽 항목. 비어 있으면 MATCH_ORDER 는 '순서 세우기'다.
    let matchTargets: [MissionOption]
    let answer: MissionAnswer
    let successFeedback: String
    let failureFeedback: String

    /// 같은 Mission 안에서 Step 을 구분하는 값. 서버가 id 를 주지 않아 내용으로 만든다.
    var id: String { "\(inputType.rawValue)-\(prompt.hashValue)" }

    /// 오답 문구. 원고가 비워두면 공용 문구를 쓴다 —
    /// **"틀렸습니다"라고 하지 않는다.** 시험이 아니라 관광이다.
    var failureText: String {
        failureFeedback.isEmpty
            ? "아직 아닌 것 같아요. 실제 대상을 다시 한번 살펴보세요."
            : failureFeedback
    }

    /// 사용자가 넣은 답이 맞는지 **단말에서** 판정한다.
    ///
    /// 서버 왕복을 하지 않는다. 현장은 통신이 불안하고, 이 게임은 경쟁이 아니라
    /// 자기 속도 관광이라 답을 숨길 이유가 약하다 (`[정답과 이야기 보기]`로 이미 열려 있다).
    func isCorrect(_ submitted: MissionAnswer) -> Bool {
        switch (inputType, answer, submitted) {
        case (.confirm, _, _):
            return true
        case (_, .text(let want), .text(let got)):
            return want == got
        case (_, .number(let want), .number(let got)):
            return want == got
        case (.shortText, .list(let allowed), .text(let got)):
            // 표기가 갈리는 답 때문에 정답을 못 맞히는 일이 제일 흔하다.
            // 공백과 대소문자를 무시하고 허용 답안 중 하나와 같으면 통과시킨다.
            let norm = { (s: String) in
                s.replacingOccurrences(of: " ", with: "").lowercased()
            }
            return allowed.map(norm).contains(norm(got))
        case (.matchOrder, .list(let want), .list(let got)):
            // 짝 맞추기는 순서가 상관없고, 순서 세우기는 상관있다.
            return matchTargets.isEmpty ? want == got : Set(want) == Set(got)
        default:
            return false
        }
    }

    /// 순서 세우기·짝짓기가 몇 개나 맞았는지. 다른 입력 타입에는 없다(nil).
    ///
    /// FINAL 같은 6개짜리 MATCH_ORDER 는 한 번에 다 맞히기 어렵다. 오답이어도
    /// 몇 개는 맞았다고 알려주면 「완전히 틀렸다」와 「거의 다 왔다」를
    /// 구분할 수 있어 다시 시도할 힘이 생긴다.
    func partialCorrectCount(_ submitted: MissionAnswer) -> Int? {
        guard inputType == .matchOrder,
              case .list(let want) = answer, case .list(let got) = submitted
        else { return nil }
        if matchTargets.isEmpty {
            // 순서 세우기: 같은 자리에 같은 id 가 와야 맞은 것이다.
            return zip(want, got).filter { $0 == $1 }.count
        } else {
            // 짝짓기: 제출한 "id>target" 쌍이 정답 집합에 있으면 맞은 것이다.
            let wantSet = Set(want)
            return got.filter { wantSet.contains($0) }.count
        }
    }
}

// MARK: - Mission

struct MissionHint: Decodable, Equatable {
    let text: String
}

struct MissionDiscovery: Decodable, Equatable {
    let title: String
    let body: String
}

/// 웹 검증 등급. 현장 답사를 하지 않기로 했으므로(2026-09-02),
/// `likely` 인 미션은 현장에서 못 찾을 수 있다 — 힌트·건너뛰기·신고가 그래서 필수다.
enum MissionVerification: String, Decodable {
    case strong, likely, unverified
}

struct Mission: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let patterns: [String]
    let prompt: String
    let steps: [MissionStep]
    let hints: [MissionHint]
    let discovery: MissionDiscovery?
    /// 채워지는 진행도 칸. 없을 수 있다 —
    /// **모든 Mission 이 독립적인 Discovery 를 가질 필요는 없다** (콘텐츠.md §13).
    let progressReward: String?
    let verification: MissionVerification
    let isShowcase: Bool
}

// MARK: - Point

struct PlayPoint: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let objective: String
    let lat: Double?
    let lng: Double?
    let navigationText: String
    let intro: String
    let missions: [Mission]

    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

// MARK: - Story

struct StorySource: Decodable, Equatable {
    let kind: String
    let ref: String
    let note: String
}

/// 발견의 의미. **놀멍봅서가 직접 쓴 문장이다** — 오디 대본을 그대로 틀지 않는다.
/// `script` 하나가 화면 자막이자 TTS 원문이다.
struct PlayStory: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let script: String
    let sources: [StorySource]
    let unlockAfterMission: String
}

// MARK: - Final · Clear · 진행도

struct FinalStage: Decodable, Equatable {
    let id: String
    let title: String
    let prompt: String
    let step: MissionStep
    // FINAL 뒤에 이야기를 끼우지 않는다 (2026-09-29 결정). FINAL 을 맞히면 바로 CLEAR —
    // 마무리 글은 `clear.body` 한 곳이 맡는다. 서버 원고도 이 칸을 받지 않는다.
    /// 2026-09-07 추가. FINAL 도 다른 Mission 처럼 힌트 2단계를 갖는다 —
    /// 「막히면 갇히지 않는다」가 FINAL 에는 빠져 있었다.
    let hints: [MissionHint]
}

struct ClearStage: Decodable, Equatable {
    let title: String
    let body: String
}

/// 이번 PLAY 에서 실제로 모으는 것 한 칸.
/// XP·코인 같은 범용 점수를 쓰지 않는다 — 성읍은 「생활기록 6칸」이다.
struct ProgressRecord: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
}

// MARK: - PLAY

enum RouteRevealMode: String, Decodable {
    case full = "FULL"
    case progressive = "PROGRESSIVE"
}

struct Play: Decodable, Identifiable, Equatable {
    let id: String
    /// 놀멍봅서가 발급한 불변 Place ID. 오디 stid 나 KTO contentId 가 아니다.
    let placeId: String
    let placeKey: String
    let placeName: String

    let title: String
    let objective: String
    let cardSummary: String

    let estimatedMinutesMin: Int
    let estimatedMinutesMax: Int
    let distanceMeters: Int
    let difficulty: String
    /// 난이도 별 (1~5). 홈 카드가 쓴다.
    /// 5단계 척도는 콘텐츠를 만들면서 PLAY 끼리 견줘 정한다 (2026-09-02 결정).
    let difficultyStars: Int

    let progressLabel: String
    let progressRecords: [ProgressRecord]

    let routeRevealMode: RouteRevealMode
    let startName: String
    let startLat: Double?
    let startLng: Double?
    let finishName: String

    let points: [PlayPoint]
    let stories: [PlayStory]
    let final: FinalStage?
    let clear: ClearStage?

    var missionCount: Int { points.reduce(0) { $0 + $1.missions.count } }

    /// 시작 버튼에 쓸 말. **모든 PLAY 가 같은 말을 쓴다** —
    /// 전에는 원고마다 세계관 말(「복원 시작」)을 따로 정했는데,
    /// PLAY 가 늘수록 같은 자리의 버튼이 매번 달라 보였다 (2026-09-03 결정).
    var startLabel: String { "플레이하기" }

    /// 이어서 할 때. 시작 문구에서 만들어 쓰지 않고 따로 둔다 —
    /// 「플레이하기」에서 「이어서 …하기」를 조립하면 말이 어색해진다.
    var resumeLabel: String { "이어서 하기" }

    /// 「60~75분」. 최소·최대가 같으면 하나만 쓴다.
    var durationText: String {
        estimatedMinutesMin == estimatedMinutesMax
            ? "\(estimatedMinutesMin)분"
            : "\(estimatedMinutesMin)~\(estimatedMinutesMax)분"
    }

    /// 「약 1km」 — 1km 미만은 m 로 쓴다.
    var distanceText: String {
        distanceMeters < 1000
            ? "\(distanceMeters)m"
            : String(format: "약 %.1fkm", Double(distanceMeters) / 1000)
                .replacingOccurrences(of: ".0km", with: "km")
    }

    /// 시작점. 원고에 좌표가 없으면 첫 Point 로 안내한다 —
    /// **추측 좌표를 넣지 않기로 했다** (`data/plays/*.json` 참조).
    var startCoordinate: CLLocationCoordinate2D? {
        if let lat = startLat, let lng = startLng {
            return CLLocationCoordinate2D(latitude: lat, longitude: lng)
        }
        return points.first?.coordinate
    }

    func story(after missionId: String) -> PlayStory? {
        stories.first { $0.unlockAfterMission == missionId }
    }

    func point(id: String) -> PlayPoint? { points.first { $0.id == id } }

    /// 모든 미션을 Point 순서대로 편 목록. 진행 계산에 쓴다.
    var orderedMissions: [(point: PlayPoint, mission: Mission)] {
        points.flatMap { p in p.missions.map { (point: p, mission: $0) } }
    }
}

// MARK: - 목록 · 지도

/// 홈 카드·지도 핀·장소 상세가 쓰는 가벼운 형태.
struct PlaySummary: Decodable, Identifiable, Equatable, Hashable {
    let id: String
    let placeId: String
    /// 픽셀 커버 파일 이름이기도 하다 (`Resources/Covers/<placeKey>.png`).
    let placeKey: String
    let placeName: String
    let title: String
    let objective: String
    /// 카드용 두 줄 요약. 비어 있으면 `objective` 를 쓴다.
    let cardSummary: String
    let estimatedMinutesMin: Int
    let estimatedMinutesMax: Int
    let distanceMeters: Int
    let difficulty: String
    let difficultyStars: Int
    let missionCount: Int
    let thumbnail: String?

    var durationText: String {
        estimatedMinutesMin == estimatedMinutesMax
            ? "\(estimatedMinutesMin)분"
            : "\(estimatedMinutesMin)~\(estimatedMinutesMax)분"
    }

    var distanceText: String {
        distanceMeters < 1000
            ? "\(distanceMeters)m"
            : String(format: "약 %.1fkm", Double(distanceMeters) / 1000)
                .replacingOccurrences(of: ".0km", with: "km")
    }
}

/// PLAY 지도 핀.
///
/// 지도가 답하는 질문이 바뀌었다 — "오디 해설이 몇 개 있나"가 아니라
/// **"제주 어디서 놀멍봅서를 할 수 있고, 앞으로 어디에 생기나"** 다.
struct PlayMapPin: Decodable, Identifiable, Equatable, Hashable {
    enum Status: String, Decodable {
        case active     // 지금 플레이할 수 있다
        case preparing  // 준비 중
    }

    let placeId: String
    let placeKey: String
    let placeName: String
    let lat: Double
    let lng: Double
    let status: Status
    let thumbnail: String?
    let play: PlaySummary?
    /// 지도에는 다 뜨지만 홈 「수행 가능한 퀘스트」에는 일부만 노출한다 —
    /// 콘텐츠 제작 착수 전 후보지까지 퀘스트 카드로 보이면 안 된다.
    let homeVisible: Bool

    var id: String { placeId }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}
