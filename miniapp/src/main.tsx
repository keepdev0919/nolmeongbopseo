// ⚠️ 공용 CSS 를 **맨 먼저** 불러온다. 화면 CSS 는 App 을 import 할 때 딸려 오므로, 이 줄이 뒤에 있으면
// 공용 규칙(.px-reset-button 의 padding·background 등)이 같은 무게의 화면 규칙을 덮어쓴다.
import './index.css';
import { SafeArea } from '@apps-in-toss/web-framework';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { hydrateStores } from './stores';

/** 하단 safe area 를 CSS 변수로 (`--px-safe-bottom` 이 최소 34px 와 함께 쓴다). */
function wireSafeArea() {
  const apply = (bottom: number) =>
    document.documentElement.style.setProperty('--ait-safe-bottom', `${Math.max(0, bottom)}px`);
  try {
    apply(SafeArea.get().bottom);
    SafeArea.subscribe({ onEvent: (insets) => apply(insets.bottom) });
  } catch {
    // 토스 밖 — env(safe-area-inset-bottom) 과 34px 최소값으로 충분하다.
  }
}

/**
 * 페이지 확대는 막고 **지도 안에서만** 두 손가락 확대를 허용한다.
 * iOS WebView 는 viewport 의 user-scalable=no 를 무시할 수 있어 제스처를 직접 막는다.
 */
function wireGestures() {
  const inMap = (t: EventTarget | null) => t instanceof Element && t.closest('.px-map') !== null;
  document.addEventListener('gesturestart', (e) => {
    if (!inMap(e.target)) e.preventDefault();
  });
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 && !inMap(e.target)) e.preventDefault();
    },
    { passive: false },
  );
  // iOS 에서 :active(버튼 눌림 가라앉기)가 동작하려면 touchstart 리스너가 하나 있어야 한다.
  document.addEventListener('touchstart', () => undefined, { passive: true });
}

/**
 * Tossface(이모지 글꼴) — 앱인토스 규칙 「모든 이모지는 Tossface 로」.
 *
 * CSS @import 로 넣으면 첫 화면이 CDN 응답을 기다린다. 스크립트로 붙인 stylesheet 는 화면을 막지 않으므로
 * 여기서 붙인다. 주소는 버전을 고정한다(1.6.1) — 고정하지 않은 /gh/ 경로는 내용이 언제든 바뀐다.
 * 글꼴 파일은 unicode-range 로 나뉘어 있어 **이모지가 화면에 나올 때만** 받는다.
 */
const TOSSFACE_CSS = 'https://cdn.jsdelivr.net/gh/toss/tossface@1.6.1/dist/tossface.css';

function wireTossface() {
  if (document.querySelector(`link[href="${TOSSFACE_CSS}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = TOSSFACE_CSS;
  document.head.appendChild(link);
}

async function boot() {
  wireTossface();
  wireSafeArea();
  wireGestures();
  // 저장된 진행·담은 코스를 먼저 올린다. 저장소가 느려도 3초 뒤엔 화면을 그린다
  // (늦게 도착한 값은 훅이 다시 그린다).
  await Promise.race([hydrateStores(), new Promise((r) => setTimeout(r, 3000))]);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
