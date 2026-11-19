---
name: ecc-click-path-audit
description: "클릭 경로 감사(ECC 원본) — 버튼·입력 하나가 부르는 함수들을 순서대로 따라가, 뒤 호출이 앞 상태를 되돌리거나 화면이 라벨과 다른 최종 상태가 되는 버그를 찾는다. 가계부처럼 한 파일에 전역 상태가 많은 앱에서 ‘눌러도 반응 없음’·‘숫자가 화면마다 다름’을 볼 때 읽는다. English: trace every user touchpoint through its state changes to find sequential undo, async races, dead paths."
metadata:
  origin: ECC (v2.2.3, affaan-m/ECC)
  upstream: skills/click-path-audit
  upstream_commit: 3f14a10
  applied: 2026-11-19 (이 레포 맞춤 선별)
  license: MIT (ECC)
---

# ECC `click-path-audit` — 이 레포 적용본

> 원본: `affaan-m/ECC` `skills/click-path-audit/SKILL.md` (v2.2.3, 3f14a10).
> 본문은 **원문 그대로**(영어) 두었다 — 다음에 원본을 갱신할 때 diff로 비교하기 위해서다.
> 규칙이 부딪히면 **이 레포 `CLAUDE.md`·`docs/`가 우선**이다. 아래 메모를 먼저 읽고, 필요한 절만 원문에서 찾아 쓴다.

## 적용 메모 (이 레포 기준)

- **이 앱 구조로 읽기**: 단일 `index.html`(약 9,600줄) + 전역 변수 + localStorage + `serverCall()`. 스킬의 Zustand/React 표현은 전역 변수·`syncNow`·3-way 병합(`mergePayloads`)으로 바꿔 읽는다.
- **화면 간 숫자 대조가 이 앱의 대표 증상**: t40(월 요약 = 월별 탭 = 입력 탭 = 예산 탭, 자산 탭 = 전체 탭 순자산). 저장·재렌더가 순서대로 겹칠 때 뒤 호출이 앞 계산을 덮는지 본다.
- **자주 나오는 패턴**: 저장 → 동기화 → 재렌더가 연달아 불릴 때(§Pattern 2 Async Race), 필터·탭 전환이 입력 중 값을 초기화할 때(§Pattern 1 Sequential Undo).
- **찾은 버그는 테스트로 남긴다**(t34·t36·t40 계열). 테스트 없이 고치고 끝내지 않는다.
- 스킬이 가리키는 superpowers 명령은 없다 — 단계(상태 지도 → 터치포인트 추적 → 보고)만 따른다.

---

<!-- ↓↓↓ ECC 원본 본문 (번역하지 않음) ↓↓↓ -->

# /click-path-audit — Behavioural Flow Audit

Find bugs that static code reading misses: state interaction side effects, race conditions between sequential calls, and handlers that silently undo each other.

## The Problem This Solves

Traditional debugging checks:
- Does the function exist? (missing wiring)
- Does it crash? (runtime errors)
- Does it return the right type? (data flow)

But it does NOT check:
- **Does the final UI state match what the button label promises?**
- **Does function B silently undo what function A just did?**
- **Does shared state (Zustand/Redux/context) have side effects that cancel the intended action?**

Real example: A "New Email" button called `setComposeMode(true)` then `selectThread(null)`. Both worked individually. But `selectThread` had a side effect resetting `composeMode: false`. The button did nothing. 54 bugs were found by systematic debugging — this one was missed.

---

## How It Works

For EVERY interactive touchpoint in the target area:

```
1. IDENTIFY the handler (onClick, onSubmit, onChange, etc.)
2. TRACE every function call in the handler, IN ORDER
3. For EACH function call:
   a. What state does it READ?
   b. What state does it WRITE?
   c. Does it have SIDE EFFECTS on shared state?
   d. Does it reset/clear any state as a side effect?
4. CHECK: Does any later call UNDO a state change from an earlier call?
5. CHECK: Is the FINAL state what the user expects from the button label?
6. CHECK: Are there race conditions (async calls that resolve in wrong order)?
```

---

## Execution Steps

### Step 1: Map State Stores

Before auditing any touchpoint, build a side-effect map of every state store action:

```
For each Zustand store / React context in scope:
  For each action/setter:
    - What fields does it set?
    - Does it RESET other fields as a side effect?
    - Document: actionName → {sets: [...], resets: [...]}
```

This is the critical reference. The "New Email" bug was invisible without knowing that `selectThread` resets `composeMode`.

**Output format:**
```
STORE: emailStore
  setComposeMode(bool) → sets: {composeMode}
  selectThread(thread|null) → sets: {selectedThread, selectedThreadId, messages, drafts, selectedDraft, summary} RESETS: {composeMode: false, composeData: null, redraftOpen: false}
  setDraftGenerating(bool) → sets: {draftGenerating}
  ...

DANGEROUS RESETS (actions that clear state they don't own):
  selectThread → resets composeMode (owned by setComposeMode)
  reset → resets everything
```

### Step 2: Audit Each Touchpoint

For each button/toggle/form submit in the target area:

```
TOUCHPOINT: [Button label] in [Component:line]
  HANDLER: onClick → {
    call 1: functionA() → sets {X: true}
    call 2: functionB() → sets {Y: null} RESETS {X: false}  ← CONFLICT
  }
  EXPECTED: User sees [description of what button label promises]
  ACTUAL: X is false because functionB reset it
  VERDICT: BUG — [description]
```

**Check each of these bug patterns:**

#### Pattern 1: Sequential Undo
```
handler() {
  setState_A(true)     // sets X = true
  setState_B(null)     // side effect: resets X = false
}
// Result: X is false. First call was pointless.
```

#### Pattern 2: Async Race
```
handler() {
  fetchA().then(() => setState({ loading: false }))
  fetchB().then(() => setState({ loading: true }))
}
// Result: final loading state depends on which resolves first
```

#### Pattern 3: Stale Closure
```
const [count, setCount] = useState(0)
const handler = useCallback(() => {
  setCount(count + 1)  // captures stale count
  setCount(count + 1)  // same stale count — increments by 1, not 2
}, [count])
```

#### Pattern 4: Missing State Transition
```
// Button says "Save" but handler only validates, never actually saves
// Button says "Delete" but handler sets a flag without calling the API
// Button says "Send" but the API endpoint is removed/broken
```

#### Pattern 5: Conditional Dead Path
```
handler() {
  if (someState) {        // someState is ALWAYS false at this point
    doTheActualThing()    // never reached
  }
}
```

#### Pattern 6: useEffect Interference
```
// Button sets stateX = true
// A useEffect watches stateX and resets it to false
// User sees nothing happen
```

### Step 3: Report

For each bug found:

```
CLICK-PATH-NNN: [severity: CRITICAL/HIGH/MEDIUM/LOW]
  Touchpoint: [Button label] in [file:line]
  Pattern: [Sequential Undo / Async Race / Stale Closure / Missing Transition / Dead Path / useEffect Interference]
  Handler: [function name or inline]
  Trace:
    1. [call] → sets {field: value}
    2. [call] → RESETS {field: value}  ← CONFLICT
  Expected: [what user expects]
  Actual: [what actually happens]
  Fix: [specific fix]
```

---

## Scope Control

This audit is expensive. Scope it appropriately:

- **Full app audit:** Use when launching or after major refactor. Launch parallel agents per page.
- **Single page audit:** Use after building a new page or after a user reports a broken button.
- **Store-focused audit:** Use after modifying a Zustand store — audit all consumers of the changed actions.

### Recommended agent split for full app:

```
Agent 1: Map ALL state stores (Step 1) — this is shared context for all other agents
Agent 2: Dashboard (Tasks, Notes, Journal, Ideas)
Agent 3: Chat (DanteChatColumn, JustChatPage)
Agent 4: Emails (ThreadList, DraftArea, EmailsPage)
Agent 5: Projects (ProjectsPage, ProjectOverviewTab, NewProjectWizard)
Agent 6: CRM (all sub-tabs)
Agent 7: Profile, Settings, Vault, Notifications
Agent 8: Management Suite (all pages)
```

Agent 1 MUST complete first. Its output is input for all other agents.

---

## When to Use

- After systematic debugging finds "no bugs" but users report broken UI
- After modifying any Zustand store action (check all callers)
- After any refactor that touches shared state
- Before release, on critical user flows
- When a button "does nothing" — this is THE tool for that

## When NOT to Use

- For API-level bugs (wrong response shape, missing endpoint) — use systematic-debugging
- For styling/layout issues — visual inspection
- For performance issues — profiling tools

---

## Integration with Other Skills

- Run AFTER `/superpowers:systematic-debugging` (which finds the other 54 bug types)
- Run BEFORE `/superpowers:verification-before-completion` (which verifies fixes work)
- Feeds into `/superpowers:test-driven-development` — every bug found here should get a test

---

## Example: The Bug That Inspired This Skill

**ThreadList.tsx "New Email" button:**
```
onClick={() => {
  useEmailStore.getState().setComposeMode(true)   // ✓ sets composeMode = true
  useEmailStore.getState().selectThread(null)      // ✗ RESETS composeMode = false
}}
```

Store definition:
```
selectThread: (thread) => set({
  selectedThread: thread,
  selectedThreadId: thread?.id ?? null,
  messages: [],
  drafts: [],
  selectedDraft: null,
  summary: null,
  composeMode: false,     // ← THIS silent reset killed the button
  composeData: null,
  redraftOpen: false,
})
```

**Systematic debugging missed it** because:
- The button has an onClick handler (not dead)
- Both functions exist (no missing wiring)
- Neither function crashes (no runtime error)
- The data types are correct (no type mismatch)

**Click-path audit catches it** because:
- Step 1 maps `selectThread` resets `composeMode`
- Step 2 traces the handler: call 1 sets true, call 2 resets false
- Verdict: Sequential Undo — final state contradicts button intent
