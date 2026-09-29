/**
 * 코스 상세 — 원본: Views/CoursePreviewView.swift + ViewModels/CoursePreviewViewModel.swift,
 *   MyCourseListView.swift 의 SavedCourseDetailView · EditCourseTitleSheet.
 *
 * 라우트 (둘 다 탭바 숨김)
 *   mode="discover"  `/course/preview/:courseId`  CoursePreviewView(course:, showsSaveButton: true)
 *                    코스는 목록이 router state 로 넘겨 준다. 없으면(새로고침·딥링크) CourseAPI.detail 로 다시 받는다.
 *   mode="saved"     `/profile/course/:savedId`   SavedCourseDetailView — 「담기」 대신 「이름 변경」·「삭제」.
 *
 * **위아래로 나눈 한 페이지**다 (2026-09-10 결정) — 제목, 지도, Day 칩, 장소 목록이 한 줄로
 * 내려오고 페이지 전체가 함께 스크롤된다. 담기·이름 변경·삭제는 아래에 붙박이로 둔다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { CourseAPI, courseHeadline, courseRegion, type Course, type CoursePlace } from '../../api';
import { useAppNavigation, useCoursePreviewParams, useSavedCourseParams } from '../../app/routes';
import { logEvent } from '../../lib/analytics';
import { boundsOf, JEJU_CENTER, regionColors, type LatLngBounds } from '../../lib/region';
import { useResource } from '../../lib/resource';
import {
  savedCourseStore,
  savedCourseToCourse,
  useIsCourseSaved,
  useSavedCourse,
} from '../../stores';
import {
  Icon,
  LoadingOverlay,
  MapView,
  PixelBottomBar,
  PixelColor,
  PixelDialog,
  PixelFont,
  PixelSheet,
  PixelStyledButton,
  type MapCamera,
  type MapMarker,
  type MapPolyline,
} from '../../ui';
import './course-preview.css';

export function CoursePreviewScreen({ mode }: { mode: 'discover' | 'saved' }) {
  return mode === 'saved' ? <SavedCourseDetail /> : <DiscoverCourseDetail />;
}

// ═══════════════════════════════ 코스 탭에서 들어온 코스 ═══════════════════════════════

/** `LoadingStep.generating` — 목록이 상세를 받는 동안 뜨는 글과 같다. */
const LOADING_TEXT = '코스 준비 중...';

function DiscoverCourseDetail() {
  const { courseId, course: passed } = useCoursePreviewParams();
  // 목록에서 넘겨 준 코스가 있으면 다시 부르지 않는다. 없을 때(새로고침·딥링크)만 받는다.
  const { data, error, loading, reload } = useResource(passed ? null : `course:${courseId}`, () =>
    CourseAPI.detail(courseId),
  );
  const course = passed ?? data ?? null;

  if (course) return <CoursePreviewView course={course} showsSaveButton />;

  if (error && !loading) {
    // iOS 는 코스를 늘 들고 들어와서 이 상태가 없다. 웹에서만 생기는 자리라
    // 코스 목록의 「코스를 가져오지 못했어요」 알림 문구와 errorView 모양을 빌린다.
    const message = error instanceof Error && error.message ? error.message : '다시 시도해주세요.';
    return (
      <div className="px-screen cpv-center">
        <div className="cpv-error">
          <Icon name="warn" size={48} color={PixelColor.locked} />
          <p style={{ ...PixelFont.body, fontWeight: 700, color: PixelColor.ink, margin: 0 }}>코스를 가져오지 못했어요</p>
          <p style={{ ...PixelFont.body, color: PixelColor.inkWeak, margin: 0 }}>{message}</p>
          <PixelStyledButton kind="primary" onClick={() => void reload()}>
            다시 시도
          </PixelStyledButton>
        </div>
      </div>
    );
  }

  return (
    <div className="px-screen">
      <LoadingOverlay text={LOADING_TEXT} />
    </div>
  );
}

// ═══════════════════════════════ 담아 둔 코스 (프로필) ═══════════════════════════════

/**
 * SavedCourseDetailView — **코스 탭에서 보던 상세 화면과 같은 것을 띄운다** (2026-09-09 결정).
 * 다른 점: 「담기」를 숨기고, 이름을 고치거나 빼는 동작을 준다 (2026-09-10 결정).
 */
function SavedCourseDetail() {
  const { savedId } = useSavedCourseParams();
  const saved = useSavedCourse(savedId);
  const nav = useAppNavigation();
  const [showEditTitle, setShowEditTitle] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 빼고 나가는 중인지. 빼는 순간 saved 가 null 이 되는데, 그걸 「없는 코스로 들어왔다」로
  // 읽고 뒤로가기를 한 번 더 부르면 두 칸을 돌아간다.
  const leaving = useRef(false);

  const course = useMemo(() => (saved ? savedCourseToCourse(saved) : null), [saved]);

  // iOS 는 시트가 담아 둔 코스를 들고 열려서 「없는 코스」가 없다. 웹은 주소로 열 수 있으니
  // 지워진(또는 모르는) 코스면 부모(프로필)로 돌려보낸다 — 시트가 닫히는 것과 같은 결과.
  useEffect(() => {
    if (!saved && !leaving.current) {
      leaving.current = true;
      nav.back();
    }
  }, [saved, nav]);

  if (!saved || !course) return <div className="px-screen" />;

  return (
    <>
      <CoursePreviewView
        course={course}
        showsSaveButton={false}
        onRename={() => setShowEditTitle(true)}
        onDelete={() => setConfirmDelete(true)}
      />
      {showEditTitle && (
        <EditCourseTitleSheet savedKey={savedId} currentTitle={saved.title} onClose={() => setShowEditTitle(false)} />
      )}
      {/* 삭제는 되돌릴 수 없으므로 한 번 묻는다. */}
      <PixelDialog
        open={confirmDelete}
        title="이 코스를 뺄까요?"
        message={`「${saved.title}」이 내 코스에서 사라져요. 코스 탭에서 다시 담을 수 있어요.`}
        actions={[
          { label: '취소', role: 'cancel' },
          {
            label: '빼기',
            role: 'destructive',
            onPress: () => {
              leaving.current = true;
              // Swift 도 `try? modelContext.save()` 로 실패를 따로 알리지 않고 닫는다.
              savedCourseStore.remove(savedId).catch(() => undefined);
              nav.back();
            },
          },
        ]}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}

/** EditCourseTitleSheet — 「코스 이름 변경」. 열릴 때 지금 이름을 채워 둔다. */
function EditCourseTitleSheet({
  savedKey,
  currentTitle,
  onClose,
}: {
  savedKey: string;
  currentTitle: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(currentTitle);
  const trimmed = draft.trim();
  const disabled = trimmed.length === 0 || trimmed === currentTitle;

  const save = () => {
    if (disabled) return;
    savedCourseStore.rename(savedKey, trimmed).catch(() => undefined);
    onClose();
  };

  return (
    <PixelSheet open onClose={onClose} title="코스 이름 변경" height="medium">
      <form
        onSubmit={(e) => {
          // 키보드의 「완료」는 키보드만 내린다 (Swift `.submitLabel(.done)`) — 저장은 버튼으로.
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <label className="cpv-field">
          <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak }}>코스 이름</span>
          <input
            className="cpv-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="코스 이름"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
          />
        </label>
        <div className="cpv-sheet-actions">
          <PixelStyledButton kind="plain" onClick={onClose}>
            취소
          </PixelStyledButton>
          <PixelStyledButton
            kind={disabled ? { fill: PixelColor.surfaceMid, label: PixelColor.inkWeak } : 'primary'}
            disabled={disabled}
            aria-disabled={disabled}
            onClick={save}
          >
            저장
          </PixelStyledButton>
        </div>
      </form>
    </PixelSheet>
  );
}

// ═══════════════════════════════ CoursePreviewView ═══════════════════════════════

/**
 * 고른 Day 를 화면 기록마다 기억한다. iOS 는 장소 상세로 들어갔다 돌아와도 화면이 살아 있어
 * 고른 날이 그대로인데, 웹은 돌아오면 다시 그려진다 — 기억해 두지 않으면 Day 1 로 튄다.
 * 기기 저장이 아니라 앱이 떠 있는 동안의 메모리다.
 */
const selectedDayMemory = new Map<string, number>();

/** 장소 좌표가 하나도 없을 때 — Swift: 가운데 (33.38, 126.55), 폭 위도 0.6 · 경도 0.8 */
const EMPTY_BOUNDS: LatLngBounds = {
  south: JEJU_CENTER.lat - 0.3,
  north: JEJU_CENTER.lat + 0.3,
  west: JEJU_CENTER.lng - 0.4,
  east: JEJU_CENTER.lng + 0.4,
};

/**
 * 지도 영역의 높이. 화면 폭에 관계없이 고정한다 — 아래 목록이 첫 화면에
 * 한두 장은 보여야 「지도 아래에 일정이 있다」는 것을 알 수 있다.
 */
const MAP_HEIGHT = 280;

interface IndexedPlace {
  /** 코스 전체에서의 순서 (0부터). 지도 번호 = index + 1 */
  index: number;
  place: CoursePlace;
}

function CoursePreviewView({
  course,
  showsSaveButton,
  onRename,
  onDelete,
}: {
  course: Course;
  /** 「담기」를 보여줄지. 이미 담아 둔 코스로 들어왔으면 숨긴다. */
  showsSaveButton: boolean;
  /** 담아 둔 코스를 관리하는 동작. 「내 코스」에서 들어왔을 때만 준다. */
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const nav = useAppNavigation();
  const locationKey = useLocation().key;

  // 전체 day 목록 (중복 제거, 정렬)
  const days = useMemo(() => [...new Set(course.places.map((p) => p.day))].sort((a, b) => a - b), [course.places]);

  // **늘 하루가 골라져 있다** (2026-09-09 결정). 「전체」는 없다 — 사흘치 경로가 한꺼번에
  // 그려지면 어느 선이 어느 날인지 알 수 없다. 처음엔 첫날.
  const [selectedDay, setSelectedDay] = useState<number>(() => {
    const remembered = selectedDayMemory.get(locationKey);
    if (remembered !== undefined && days.includes(remembered)) return remembered;
    return days[0] ?? 1;
  });
  const selectDay = (day: number) => {
    setSelectedDay(day);
    selectedDayMemory.set(locationKey, day);
  };

  // 전체 장소 순서 유지한 indexed 배열 (지도 마커 번호용)
  const indexedPlaces = useMemo<IndexedPlace[]>(
    () => course.places.map((place, index) => ({ index, place })),
    [course.places],
  );

  // day 기준으로 장소 그룹핑
  const dayPlaces = useMemo(() => course.places.filter((p) => p.day === selectedDay), [course.places, selectedDay]);

  // day 섹션의 첫 번째 장소가 전체 places 배열에서 갖는 오프셋 (목록 번호용)
  const globalOffset = useMemo(() => {
    const first = dayPlaces[0];
    if (!first) return 0;
    const idx = course.places.findIndex((p) => p.name === first.name && p.day === first.day);
    return idx >= 0 ? idx : 0;
  }, [course.places, dayPlaces]);

  // 담기
  const isSaved = useIsCourseSaved(course);
  const toast = useToast();
  const save = useCallback(async () => {
    if (isSaved) return;
    // 화면 상태만 믿지 않고 저장소를 다시 본다 — 다른 경로로 이미 담겼을 수 있다.
    if (savedCourseStore.isSaved(course)) {
      toast.show('이미 담아 둔 코스예요');
      return;
    }
    try {
      const result = await savedCourseStore.save(course);
      if (result !== 'already') logEvent('course_save', { region: courseRegion(course), days: course.durationDays });
      toast.show(result === 'already' ? '이미 담아 둔 코스예요' : '코스가 저장됐어요!');
    } catch {
      // ⚠️ 실패했는데 「저장됐어요」라고 말하지 않는다. 저장소가 담을 뻔한 것도 도로 뺀다.
      toast.show('담지 못했어요. 잠시 후 다시 시도해 주세요', true);
    }
  }, [course, isSaved, toast]);

  const region = courseRegion(course);
  const colors = regionColors(region);
  const hasActions = showsSaveButton || !!onRename || !!onDelete;

  return (
    <div className="px-screen">
      {/* ── Header ── 목록 카드와 같은 말을 같은 순서로: 「성산일출봉 외 6곳」 + 권역 칩 + 일수 칩 */}
      <header className="cpv-header">
        <h1 className="cpv-title" style={PixelFont.sectionTitle}>
          {course.title.length === 0 ? '이름 없는 코스' : courseHeadline(course)}
        </h1>
        <div className="cpv-chips">
          <HeaderChip fill={colors.fill} on={colors.on}>
            {region}
          </HeaderChip>
          <HeaderChip fill={PixelColor.surface} on={PixelColor.ink}>
            <Icon name="calendar" size={14} />
            <span>{course.durationDays}일 일정</span>
          </HeaderChip>
        </div>
      </header>

      {/* ── Map ── */}
      <CourseMap items={indexedPlaces} selectedDay={selectedDay} />

      {/* ── Day Tab Bar ── 하루뿐이면 칩을 그리지 않는다 */}
      {days.length > 1 && (
        <div className="cpv-days">
          <div className="cpv-days__row" role="tablist" aria-label="일차">
            {days.map((day) => {
              const selected = selectedDay === day;
              return (
                <button
                  key={day}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="px-reset-button cpv-day"
                  onClick={() => selectDay(day)}
                >
                  <span className={`cpv-day__chip${selected ? ' is-selected' : ''}`} style={PixelFont.labelSmall}>
                    <span>Day {day}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 고른 하루 (DaySectionView) ── 섹션 머리는 없다: 위 칩이 이미 「Day 1」이라고 말한다 */}
      <section className="cpv-section">
        {/* 카드를 누르면 장소 정보가 열린다는 것을 **말로도** 알린다 */}
        <div className="cpv-hint">
          <Icon name="info" size={14} color={PixelColor.inkWeak} />
          <span style={PixelFont.labelSmall}>장소를 누르면 이용 정보를 볼 수 있어요</span>
        </div>
        {dayPlaces.map((place, idx) => (
          <div key={idx} className="cpv-place-wrap">
            <button
              type="button"
              className="px-reset-button px-border px-press cpv-place"
              style={{ ['--px-press-offset' as string]: '2px' } as CSSProperties}
              onClick={() => nav.toPlaceDetail({ name: place.name, lat: place.lat, lng: place.lng })}
            >
              <PlaceCard index={globalOffset + idx + 1} place={place} />
            </button>
          </div>
        ))}
      </section>

      {/* ── Action Buttons ── 목록을 끝까지 내려야 나오면 담을 마음이 든 순간에 버튼이 없다 */}
      {hasActions && (
        <PixelBottomBar style={{ padding: '10px 16px calc(14px + var(--px-safe-bottom))' }}>
          <div className="cpv-actions">
            {showsSaveButton && (
              <p style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak, textAlign: 'center', margin: 0 }}>
                추천 일정이 마음에 드세요?
              </p>
            )}
            {showsSaveButton && (
              // 담기는 위 권역 칩과 같은 색 — 화면이 초록 한 가지로 몰리지 않게. 「전체」 코스는 잉크.
              <PixelStyledButton
                kind={{ fill: colors.fill, label: colors.on }}
                style={{ width: '100%' }}
                disabled={isSaved}
                onClick={() => void save()}
              >
                <Icon name={isSaved ? 'check' : 'download'} size={16} />
                <span>{isSaved ? '저장됨' : '담기'}</span>
              </PixelStyledButton>
            )}
            {(onRename || onDelete) && (
              <div className="cpv-actions__row">
                {onRename && (
                  <PixelStyledButton kind="plain" style={PixelFont.labelSmall} onClick={onRename}>
                    <Icon name="edit" size={16} />
                    <span>이름 변경</span>
                  </PixelStyledButton>
                )}
                {onDelete && (
                  // 삭제는 되돌릴 수 없다. 글자만 경고색으로 두고 면은 흰색으로 남긴다.
                  <PixelStyledButton
                    kind={{ fill: PixelColor.surface, label: PixelColor.locked }}
                    style={PixelFont.labelSmall}
                    onClick={onDelete}
                  >
                    <Icon name="close" size={16} />
                    <span>삭제</span>
                  </PixelStyledButton>
                )}
              </div>
            )}
          </div>
        </PixelBottomBar>
      )}

      <ToastView toast={toast.state} />
    </div>
  );
}

/** 제목 아래 칩. 픽셀 버튼과 같은 꼴(테두리 2 + 작은 그림자), 목록 카드의 배지와 같은 높이(28). */
function HeaderChip({ fill, on, children }: { fill: string; on: string; children: ReactNode }) {
  return (
    <span
      className="cpv-chip px-border px-shadow-small"
      style={{ ...PixelFont.labelSmall, background: fill, color: on }}
    >
      {children}
    </span>
  );
}

// ═══════════════════════════════ 지도 (MapWithPolyline) ═══════════════════════════════

/**
 * ⚠️ 번호는 **코스 전체 기준**이다 (2026-09-09). 고른 날만 다시 1부터 세면 지도 마커와
 * 아래 목록의 번호가 어긋난다. Day 를 바꾸면 그날 장소가 모두 들어오도록 카메라를 다시 맞춘다.
 * 경로(번호·좌표)가 그대로면 카메라를 건드리지 않는다 — 손으로 옮긴 지도가 튕겨 돌아가지 않게.
 */
function CourseMap({ items, selectedDay }: { items: IndexedPlace[]; selectedDay: number }) {
  const dayItems = useMemo(() => items.filter((i) => i.place.day === selectedDay), [items, selectedDay]);

  const routeKey = dayItems.map((i) => `${i.index}:${i.place.lat},${i.place.lng}`).join('|');

  const markers = useMemo<MapMarker[]>(
    () =>
      dayItems.map((i) => ({
        id: `place-${i.index}`,
        kind: 'number',
        label: String(i.index + 1),
        size: 28,
        font: 'labelSmall',
        position: { lat: i.place.lat, lng: i.place.lng },
        title: i.place.name,
      })),
    [dayItems],
  );

  const coords = useMemo(() => dayItems.map((i) => ({ lat: i.place.lat, lng: i.place.lng })), [dayItems]);

  const polylines = useMemo<MapPolyline[]>(
    () =>
      coords.length >= 2
        ? [{ id: 'day', path: coords, color: PixelColor.primary, width: 3.5, dashArray: '8 5', opacity: 0.85 }]
        : [],
    [coords],
  );

  // 그날 장소가 모두 들어오는 사각형. 점 하나거나 거의 한 줄이면 반경 800m 를 확보한다.
  const bounds = boundsOf(coords);
  const camera: MapCamera = bounds
    ? { kind: 'bounds', bounds, padding: { top: 32, right: 40, bottom: 32, left: 40 }, minSpanMeters: 800 }
    : { kind: 'bounds', bounds: EMPTY_BOUNDS, padding: 0 };

  return (
    <MapView
      height={MAP_HEIGHT}
      markers={markers}
      polylines={polylines}
      camera={camera}
      cameraKey={`route:${routeKey}`}
      ariaLabel={`Day ${selectedDay} 코스 지도`}
    />
  );
}

// ═══════════════════════════════ PlaceCard ═══════════════════════════════

function PlaceCard({ index, place }: { index: number; place: CoursePlace }) {
  return (
    <>
      <NumberedMarker number={index} />
      <span className="cpv-place__text">
        <span className="cpv-place__name" style={PixelFont.body}>
          {place.name}
        </span>
        {place.startTime && place.startTime.length > 0 && (
          <span style={{ ...PixelFont.labelSmall, color: PixelColor.inkWeak }}>{place.startTime}</span>
        )}
      </span>
      {/* 「눌러서 들어가는 줄」이라는 표시. 장소 상세의 주변 시설 줄과 같다. */}
      <Icon name="forward" size={18} color={PixelColor.inkWeak} style={{ marginTop: 7 }} />
    </>
  );
}

function NumberedMarker({ number }: { number: number }) {
  return (
    <span className="cpv-num" style={PixelFont.labelSmall}>
      {number}
    </span>
  );
}

// ═══════════════════════════════ 토스트 ═══════════════════════════════

interface ToastState {
  text: string | null;
  isError: boolean;
  visible: boolean;
}

/** 화면 위에 2초 떴다 사라지는 알림 (CoursePreviewViewModel.show). */
function useToast() {
  const [state, setState] = useState<ToastState>({ text: null, isError: false, visible: false });
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = useCallback((text: string, isError = false) => {
    window.clearTimeout(timer.current);
    setState({ text, isError, visible: true });
    timer.current = window.setTimeout(() => {
      setState((s) => ({ ...s, visible: false }));
    }, 2000);
  }, []);

  return useMemo(() => ({ state, show }), [state, show]);
}

/**
 * 실패는 **다른 색**으로 띄운다. 같은 초록으로 띄우면 「담지 못했어요」가 성공 알림처럼 스쳐 지나간다.
 * 사라질 때도 미끄러져 나가도록 자리는 늘 두고 보이기만 바꾼다.
 */
function ToastView({ toast }: { toast: ToastState }) {
  return createPortal(
    <div className="cpv-toast-layer" role="status" aria-live="polite">
      <div
        className={`cpv-toast${toast.visible ? ' is-on' : ''}`}
        style={{
          ...PixelFont.body,
          background: toast.isError ? PixelColor.locked : PixelColor.done,
          color: toast.isError ? PixelColor.onLocked : PixelColor.onDone,
        }}
      >
        {toast.text}
      </div>
    </div>,
    document.body,
  );
}
