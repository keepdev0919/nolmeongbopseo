import traceback
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from routers import course, tts, tourist, place, home, play, report, legal, event

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="놀멍봅서 API", version="0.1.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(course.router)
app.include_router(tts.router)
app.include_router(tourist.router)
app.include_router(place.router)
app.include_router(home.router)
app.include_router(play.router)
app.include_router(report.router)
app.include_router(event.router)
app.include_router(legal.router)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"[GLOBAL 500] {request.method} {request.url.path}")
    print(f"  {type(exc).__name__}: {exc}")
    print(tb)
    # 예외 종류·메시지를 응답에 담지 않는다. 내부 구조와 라이브러리 정보가 새고,
    # 인증 엔드포인트에서는 입력에 따라 다른 메시지가 나와 오라클이 된다.
    # 진단 정보는 위 서버 로그로만 남긴다.
    return JSONResponse(
        status_code=500,
        content={"detail": "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요."},
    )


@app.get("/health")
def health():
    return {"status": "ok"}
