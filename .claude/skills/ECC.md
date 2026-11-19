# `.claude/skills/ecc-*` — ECC에서 골라 온 스킬 (2026-11-19)

원본: `affaan-m/ECC` **v2.2.3** — `skills/` 327종 · `rules/` 122파일 · `agents/` 72종 · `commands/` 98종 (커밋 `3f14a10`).
한 파일 앱의 실제 증상(눌러도 반응 없음·화면마다 숫자가 다름·폰 가독성)에 바로 쓰는 **2개**만 골랐다.
본문은 영어 원문 그대로, 앞머리에 이 레포 기준 한국어 메모. **규칙이 부딪히면 `CLAUDE.md`가 우선이다.**

| 스킬 | 원본 | 이 레포에서 쓰는 자리 | 주의 |
|---|---|---|---|
| `ecc-click-path-audit` | `click-path-audit` | 버튼·탭 하나가 부르는 저장·동기화·재렌더 순서를 따라가 상태가 서로를 덮는지 확인 | 전역 변수·`serverCall`·3-way 병합으로 읽기. 스킬의 그대로 쓰는 자리(React/Zustand) 아님 |
| `ecc-make-interfaces-feel-better` | `make-interfaces-feel-better` | 폰(360·390) 가독성 — 여백·줄바꿈·터치 영역·모션 | PC(1400)는 기본 유지. t34·t36 기대값이 판정 기준 |

## 갱신·제거

- **갱신**: 원본 `skills/<이름>/SKILL.md`와 각 폴더 원문 본문(구분선 아래)을 비교. 원본 SHA가 달라지면 `upstream_commit`도 같이.
- **제거**: `ecc-*` 폴더 삭제로 끝. `tests/`는 이 폴더를 읽지 않는다. (테스트는 저장소 밖 백업 JSON이 있어야 돌아간다 — `../gaegyebu-data/`.)
