import SwiftUI
import SwiftData
import GoogleMaps

@main
struct JejuFolkloreApp: App {
    init() {
        // 시스템 내비게이션 바·리스트 외형을 팔레트에 맞춘다.
        PixelChrome.apply()

        // Google Maps API 키는 환경변수 GOOGLE_MAPS_API_KEY 로 주입한다.
        // Xcode > Edit Scheme > Run > Arguments > Environment Variables 에서 설정하거나,
        // Info.plist 의 GOOGLE_MAPS_API_KEY 키를 사용한다.
        let envKey = ProcessInfo.processInfo.environment["GOOGLE_MAPS_API_KEY"] ?? ""
        let plistKey = (Bundle.main.object(forInfoDictionaryKey: "GOOGLE_MAPS_API_KEY") as? String) ?? ""
        let apiKey = !envKey.isEmpty ? envKey : plistKey
        if !apiKey.isEmpty {
            GMSServices.provideAPIKey(apiKey)
        } else {
            #if DEBUG
            print("[GoogleMaps] API 키가 설정되지 않았습니다. GOOGLE_MAPS_API_KEY 환경변수를 설정하세요.")
            #endif
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: SavedCourse.self)
    }
}
