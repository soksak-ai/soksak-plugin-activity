# soksak-plugin-activity

프로젝트 창 사이드바의 활동로그 — 오케스트레이터 피드가 그리는 **동일한 허브 스트림**을 일하는 자리에서 보여준다. 스펙에 `tts`가 실린 엔트리는 [soksak-plugin-vtube-tts](https://github.com/soksak-ai/soksak-plugin-vtube-tts) 캐릭터가 소리 내어 읽는다.

English: [README.md](README.md)

```
활동 허브(코어) ──> 오케스트레이터 피드
        └─ 플러그인 이벤트 "activity" ──> 이 사이드바(동일 엔트리)
                                            └─ tts 엔트리 → vtube-tts.say (spec tts:false — 되먹임 불가)
```

## 동작

- 백필 `activity.recent` + 라이브 `activity` 플러그인 이벤트 — 폴링 없음, 창 필터 없음(전체 스트림, 오케스트레이터 동등성)
- 낭독은 MESSAGE-PROTOCOL tts 스펙만 따른다: `payload.tts`가 있는 엔트리를 **도착 순서대로, 스킵 없이** 읽고, 없는 엔트리(`turn.ended` AI 발화, `say` 실행 등)는 침묵. 이 플러그인은 자체 읽기 규칙을 만들지 않는다
- `vtube` 토글(사이드바 버튼/설정/커맨드): 켬 = 마스코트 등장 + 낭독, 끔 = 텍스트 로그만
- `soksak-plugin-vtube-tts` 의존 — 이 플러그인을 설치하면 엔진도 연관 설치된다

## 커맨드

`plugin.soksak-plugin-activity.<이름>`: `ping` · `list {limit}` (tts/narrated 플래그 포함) · `vtube.toggle {on?}`
