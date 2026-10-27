// DEEP DIVE — 관심사 탐색 웹앱 서버
// 의존성 없음 (Node 18 이상). 실행: node server.js
// 환경변수:
//   ANTHROPIC_API_KEY  — Claude API 키 (없으면 내장 질문 엔진으로 동작)
//   TEACHER_PASSWORD   — 설정하면 수업 만들기에 비밀번호 필요 (공개 배포 시 권장)
//   PORT               — 기본 3000
//   AI_MODEL           — 기본 claude-haiku-5-5

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
// "sk-"로 시작하는 진짜 키만 사용 (비워두거나 none 등을 넣으면 무료 내장 엔진으로 동작)
const API_KEY = /^sk-/.test(process.env.ANTHROPIC_API_KEY || "") ? process.env.ANTHROPIC_API_KEY.trim() : "";
const MODEL = process.env.AI_MODEL || "claude-haiku-5-5";
// 비워두거나 none 이면 비밀번호 없이 수업을 만들 수 있음
const TEACHER_PASSWORD = /^(none)?$/i.test((process.env.TEACHER_PASSWORD || "").trim()) ? "" : process.env.TEACHER_PASSWORD.trim();
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
// public/ 폴더가 있으면 거기서, 없으면 server.js와 같은 폴더에서 화면 파일을 찾습니다.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const STATIC_FILES = new Set(["index.html", "teacher.html", "qrcode.js"]);

// ───────────────────────── 저장소 ─────────────────────────
let store = { sessions: {} };
try {
  if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch (e) {
  console.warn("data.json 읽기 실패, 새로 시작합니다:", e.message);
}
let dirty = false;
function save() { dirty = true; }
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  // 7일 지난 수업은 정리
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [c, s] of Object.entries(store.sessions)) if (s.createdAt < cutoff) delete store.sessions[c];
  fs.writeFile(DATA_FILE, JSON.stringify(store), () => {});
}, 3000);

function newCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(""); }
  while (store.sessions[c]);
  return c;
}

// ───────────────────────── 안전 필터 ─────────────────────────
const BLOCKED = [
  "자살", "자해", "죽고싶", "죽는법", "목매", "손목", "섹스", "야동", "포르노", "성관계", "야한", "음란",
  "마약", "대마", "필로폰", "살인", "살해", "폭탄", "총 만드", "총기 제작", "테러", "도박", "불법", "해킹",
  "suicide", "porn", "sex", "drug", "cocaine", "bomb", "kill",
];
function isUnsafe(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, "");
  return BLOCKED.some((w) => t.includes(w.replace(/\s+/g, "")));
}
function clean(s, max = 40) {
  return String(s || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ───────────────────────── AI (Claude API) ─────────────────────────
const SYSTEM = `너는 중학교 1학년 학생이 자기 관심사를 구체적으로 발견하도록 돕는 '탐색 가이드'다.
규칙:
1. 정답이나 지식을 설명하지 않는다. 다음에 고를 선택지만 만든다.
2. 지금까지의 경로보다 딱 한 단계만 더 구체적인 방향을 제안한다.
3. 질문은 한 문장, 반말, 친근하게, 25자 이내.
4. 선택지는 4~6개, 각각 12자 이내, 서로 다른 방향.
5. 중1이 바로 이해하는 쉬운 단어만. 전문용어는 피한다.
6. 학생의 관심을 평가하거나 훈계하지 않는다. 어떤 관심이든 존중한다.
7. 선택지에 '잘 모르겠어'는 넣지 않는다(앱이 자동으로 붙인다).
8. 성적·자해·폭력·위험행위·불법·혐오·개인정보 관련 내용은 절대 만들지 않는다.
반드시 JSON만 출력한다. 다른 말은 쓰지 않는다.`;

async function callClaude(userPrompt, maxTokens = 400) {
  if (!API_KEY) throw new Error("no_key");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error("api_" + res.status + " " + (await res.text()).slice(0, 200));
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return parseJSON(text);
  } finally {
    clearTimeout(timer);
  }
}
function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("bad_json");
}

// ───────────────────────── 내장 질문 엔진 (AI 없을 때 / 실패 시) ─────────────────────────
const STARTERS = {
  축구: ["직접 하는 축구", "해외축구", "K리그", "국가대표", "선수", "축구게임"],
  야구: ["직접 하는 야구", "프로야구 팀", "선수", "응원 문화", "경기 기록", "야구장"],
  농구: ["직접 하는 농구", "NBA", "선수", "멋진 기술", "농구화", "팀 경기"],
  게임: ["RPG", "액션·슈팅", "모바일 게임", "캐릭터", "게임 만들기", "e스포츠"],
  아이돌: ["무대", "노래", "춤", "의상·콘셉트", "멤버", "팬 문화"],
  음악: ["노래 듣기", "악기 연주", "가수", "작곡", "공연", "뮤직비디오"],
  수학: ["도형", "숫자 퍼즐", "패턴", "계산 비법", "수학자 이야기", "생활 속 수학"],
  과학: ["우주", "동물·생물", "실험", "로봇", "날씨", "인체"],
  우주: ["행성", "블랙홀", "우주인", "로켓", "외계인", "별자리"],
  역사: ["한국사", "세계사", "옛날 사람들 생활", "전쟁 이야기", "왕과 인물", "유물"],
  강아지: ["강아지 종류", "행동과 표정", "훈련", "강아지와 사람", "돌보기", "유기견"],
  고양이: ["고양이 종류", "행동과 표정", "고양이 마음", "돌보기", "길고양이", "고양이 사진"],
  동물: ["반려동물", "야생동물", "바다 생물", "곤충", "멸종 위기", "동물 행동"],
  음식: ["라면", "디저트", "길거리 음식", "요리하기", "나라별 음식", "음식 포장"],
  그림: ["캐릭터 그리기", "웹툰", "색칠", "유명 화가", "디지털 드로잉", "낙서"],
  영화: ["애니메이션", "히어로", "공포", "영화 만들기", "배우", "명장면"],
  웹툰: ["좋아하는 작품", "캐릭터", "그림체", "스토리", "웹툰 작가", "웹툰 만들기"],
  자동차: ["스포츠카", "전기차", "자동차 디자인", "레이싱", "자율주행", "자동차 만드는 법"],
  패션: ["옷 코디", "신발", "브랜드", "색깔 조합", "옛날 패션", "옷 만들기"],
  여행: ["다른 나라", "국내 여행", "여행 음식", "랜드마크", "여행 사진", "교통수단"],
};
const FACETS = [
  null, // depth 1 handled separately
  { q: (p) => `${p}의 어떤 점이 좋아?`, c: ["모양과 색", "사람들", "방법과 기술", "변화와 성장", "재미있는 사실", "분위기와 느낌"] },
  { q: (p) => `${p}에서 뭐가 더 궁금해?`, c: ["어떻게 시작됐는지", "어떻게 만드는지", "왜 인기 있는지", "잘하는 비결", "실패와 도전", "미래의 모습"] },
  { q: () => `그중에서 하나만 고른다면?`, c: ["처음 시작", "숨은 이야기", "비교해 보기", "기록과 숫자", "직접 체험", "사람들 반응"] },
  { q: (p) => `${p}, 어떤 쪽으로 더 볼까?`, c: ["한 사람 이야기", "여러 개 비교", "옛날과 지금", "우리 주변에서", "세계에서", "직접 만들어 보기"] },
];
const GENERIC_START = ["보는 것", "직접 해보기", "사람·인물", "만드는 과정", "숨은 이야기", "숫자와 기록"];
const EASY = ["보는 게 좋아", "해보는 게 좋아", "이야기가 좋아", "만드는 게 좋아", "사람이 좋아"];

function shuffle(a) { return a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]); }

function fallbackNext(trail, mode) {
  const last = trail[trail.length - 1];
  if (mode === "easier") return { question: "괜찮아! 그럼 이 중엔 뭐가 더 끌려?", choices: EASY };
  if (trail.length === 1) {
    const key = Object.keys(STARTERS).find((k) => last.includes(k));
    return { question: `${last}에서 어떤 쪽이 더 좋아?`, choices: key ? STARTERS[key] : GENERIC_START };
  }
  const f = FACETS[Math.min(trail.length - 1, FACETS.length - 1)];
  const choices = mode === "other" ? shuffle(f.c) : f.c;
  return { question: f.q(last), choices: choices.slice(0, 6) };
}
// 받침에 따라 조사 고르기: j("축구","을","를") → "축구를"
function j(word, withB, withoutB) {
  const ch = String(word).trim().slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return word + withoutB;
  return word + ((code % 28) ? withB : withoutB);
}
function fallbackResult(trail) {
  const first = trail[0];
  const last = trail[trail.length - 1];
  const mid = trail.length > 2 ? trail[1] : first;
  return {
    interest: `${mid}의 '${last}'`,
    summary: `너는 ${first} 전체보다, 그중에서도 '${last}' 쪽에 더 끌리는 것 같아.`,
    question: `${first}에서 '${last}'에는 어떤 이야기가 숨어 있을까?`,
  };
}
function fallbackExhibition(trail, interest) {
  const first = trail[0];
  const last = trail[trail.length - 1];
  return {
    title: `${last}의 비밀`,
    theme: `${j(first, "을", "를")} '${last}'의 눈으로 다시 보는 전시`,
    show: [`${first} 사진이나 그림`, `'${last}' 관련 물건`, "비교해 볼 수 있는 자료", "내가 찾은 재미있는 사실"],
    experience: `관객이 '${last}'에 대해 가장 궁금한 점을 포스트잇에 적어 붙이기`,
  };
}

// ───────────────────────── 엔진 (AI → 실패 시 내장) ─────────────────────────
function sanitizeNext(o) {
  const question = clean(o && o.question, 40);
  let choices = Array.isArray(o && o.choices) ? o.choices.map((c) => clean(c, 16)).filter(Boolean) : [];
  choices = [...new Set(choices)].filter((c) => !/모르겠/.test(c) && !isUnsafe(c)).slice(0, 6);
  if (!question || choices.length < 3 || isUnsafe(question)) throw new Error("bad_shape");
  return { question, choices };
}

async function engineNext(trail, mode, step, maxStep, avoid) {
  const pathStr = trail.join(" > ");
  let instr = "";
  if (mode === "easier")
    instr = `학생이 방금 질문에 '잘 모르겠어'를 눌렀다. 현재 위치(${trail[trail.length - 1]})에서 더 쉽고 감각적인 선택지(보기, 해보기, 느낌 위주)로 다시 물어봐. 질문은 "괜찮아!"로 시작해.`;
  else if (mode === "other")
    instr = `학생이 다른 방향을 원한다. 아래 선택지와 겹치지 않는 새로운 방향으로 만들어.\n이전 선택지: ${(avoid || []).join(", ")}`;
  else instr = `'${trail[trail.length - 1]}'보다 한 단계 더 구체적인 하위 방향을 물어봐.`;
  const prompt = `학생: 중학교 1학년
지금까지 탐색 경로: ${pathStr}
현재 단계: ${step} / ${maxStep}
${instr}
${step >= maxStep - 1 ? "곧 탐색이 끝나니, 선택지가 '알아보고 싶은 질문'으로 이어질 만큼 구체적이면 좋다.\n" : ""}출력 형식: {"question":"...","choices":["...","...","...","...","..."]}`;
  try {
    return { ...sanitizeNext(await callClaude(prompt)), ai: true };
  } catch (e) {
    if (e.message !== "no_key") console.warn("AI 실패 → 내장 엔진:", e.message);
    return { ...fallbackNext(trail, mode), ai: false };
  }
}

async function engineResult(trail) {
  const prompt = `중1 학생이 선택으로 파고든 경로: ${trail.join(" > ")}
이 학생의 관심을 정리해 줘.
- interest: 관심 주제 한 줄 (20자 이내, 명사형. 예: "축구선수가 프로가 되는 과정")
- summary: "너는 ~보다 ~에 관심이 있어 보여." 형식의 한 문장 (50자 이내)
- question: 더 알아보고 싶은 질문 하나 (물음표로 끝, 35자 이내. 예: "축구선수는 어떤 과정을 거쳐 프로가 될까?")
출력 형식: {"interest":"...","summary":"...","question":"..."}`;
  try {
    const o = await callClaude(prompt);
    const r = { interest: clean(o.interest, 40), summary: clean(o.summary, 90), question: clean(o.question, 70) };
    if (!r.interest || !r.question || isUnsafe(r.interest + r.summary + r.question)) throw new Error("bad_shape");
    return { ...r, ai: true };
  } catch (e) {
    if (e.message !== "no_key") console.warn("AI 실패 → 내장 결과:", e.message);
    return { ...fallbackResult(trail), ai: false };
  }
}

async function engineExhibition(trail, interest, question) {
  const prompt = `중1 학생의 관심: ${interest}
탐색 경로: ${trail.join(" > ")}
궁금한 질문: ${question}
이 관심으로 학교에서 만들 수 있는 작은 전시 아이디어 초안을 만들어 줘. 쉽고 짧게.
- title: 전시 제목 (12자 이내, 끌리는 말. 《》 기호는 빼고)
- theme: 어떤 전시인지 한 문장 (45자 이내)
- show: 전시에서 보여줄 것 3~5개 (각 15자 이내, 학생이 실제로 준비 가능한 것)
- experience: 관객이 해볼 체험 한 가지 (40자 이내)
출력 형식: {"title":"...","theme":"...","show":["..."],"experience":"..."}`;
  try {
    const o = await callClaude(prompt, 500);
    const r = {
      title: clean(o.title, 24).replace(/[《》]/g, ""),
      theme: clean(o.theme, 90),
      show: (Array.isArray(o.show) ? o.show : []).map((s) => clean(s, 30)).filter(Boolean).slice(0, 5),
      experience: clean(o.experience, 80),
    };
    if (!r.title || r.show.length < 2 || isUnsafe(JSON.stringify(r))) throw new Error("bad_shape");
    return { ...r, ai: true };
  } catch (e) {
    if (e.message !== "no_key") console.warn("AI 실패 → 내장 전시:", e.message);
    return { ...fallbackExhibition(trail, interest), ai: false };
  }
}

// ───────────────────────── HTTP ─────────────────────────
function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 20000) { reject(new Error("too_large")); req.destroy(); } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("bad_json")); } });
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}

function getStudent(code, sid) {
  const s = code && store.sessions[code];
  return s && sid && s.students[sid] ? { session: s, student: s.students[sid] } : null;
}
function touch(st, patch) { Object.assign(st, patch, { updatedAt: Date.now() }); save(); }
function cleanTrail(t) {
  return (Array.isArray(t) ? t : []).map((x) => clean(x, 24)).filter(Boolean).slice(0, 12);
}
function teacherOk(s, key) { return s && key && crypto.timingSafeEqual(Buffer.from(String(key).padEnd(64).slice(0, 64)), Buffer.from(s.teacherKey.padEnd(64).slice(0, 64))); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    // 정적 파일
    if (req.method === "GET" && !p.startsWith("/api/")) {
      if (p === "/" || p === "/index.html") return serveFile(res, path.join(PUBLIC_DIR, "index.html"));
      if (p === "/teacher" || p === "/teacher.html") return serveFile(res, path.join(PUBLIC_DIR, "teacher.html"));
      const name = p.replace(/^\/+/, "");
      if (!STATIC_FILES.has(name)) { res.writeHead(404); return res.end("Not found"); }
      return serveFile(res, path.join(PUBLIC_DIR, name));
    }

    if (p === "/api/config" && req.method === "GET")
      return send(res, 200, { ai: !!API_KEY, needPassword: !!TEACHER_PASSWORD });

    // ── 강사 ──
    if (p === "/api/session" && req.method === "POST") {
      const b = await readBody(req);
      if (TEACHER_PASSWORD && b.password !== TEACHER_PASSWORD) return send(res, 403, { error: "비밀번호가 맞지 않아요." });
      const code = newCode();
      const teacherKey = crypto.randomBytes(16).toString("hex");
      store.sessions[code] = { code, title: clean(b.title, 40) || "관심 탐험 수업", teacherKey, ended: false, createdAt: Date.now(), maxStep: 5, students: {} };
      save();
      return send(res, 200, { code, teacherKey });
    }
    let m = p.match(/^\/api\/teacher\/([A-Z0-9]{4})(\/(end|reopen|reset|remove))?$/);
    if (m) {
      const s = store.sessions[m[1]];
      const key = url.searchParams.get("k") || req.headers["x-teacher-key"];
      if (!teacherOk(s, key)) return send(res, 403, { error: "수업을 찾을 수 없어요." });
      if (req.method === "GET" && !m[2]) {
        const students = Object.values(s.students).sort((a, b) => a.joinedAt - b.joinedAt).map((st) => ({
          id: st.id, name: st.name, status: st.status, trail: st.trail, interest: st.interest, question: st.question, exhibition: st.exhibition, updatedAt: st.updatedAt,
        }));
        return send(res, 200, { code: s.code, title: s.title, ended: s.ended, students });
      }
      if (req.method === "POST") {
        if (m[3] === "end") s.ended = true;
        if (m[3] === "reopen") s.ended = false;
        if (m[3] === "reset") { s.students = {}; s.ended = false; }
        if (m[3] === "remove") { const b = await readBody(req); delete s.students[b.id]; }
        save();
        return send(res, 200, { ok: true });
      }
    }

    // ── 학생 ──
    m = p.match(/^\/api\/session\/([A-Za-z0-9]{4})$/);
    if (m && req.method === "GET") {
      const s = store.sessions[m[1].toUpperCase()];
      if (!s) return send(res, 404, { error: "수업 코드를 찾을 수 없어요." });
      return send(res, 200, { code: s.code, title: s.title, ended: s.ended });
    }
    if (p === "/api/join" && req.method === "POST") {
      const b = await readBody(req);
      const code = String(b.code || "").toUpperCase();
      const s = store.sessions[code];
      if (!s) return send(res, 404, { error: "수업 코드를 찾을 수 없어요." });
      const name = clean(b.name, 12);
      if (!name) return send(res, 400, { error: "이름이나 별명을 적어줘." });
      if (isUnsafe(name)) return send(res, 400, { error: "다른 별명을 써볼까?" });
      if (Object.keys(s.students).length >= 60) return send(res, 400, { error: "이 수업은 인원이 꽉 찼어요." });
      // 같은 기기 재입장
      if (b.sid && s.students[b.sid]) { touch(s.students[b.sid], { name }); return send(res, 200, { sid: b.sid }); }
      const sid = crypto.randomBytes(8).toString("hex");
      s.students[sid] = { id: sid, name, status: "joined", trail: [], joinedAt: Date.now(), updatedAt: Date.now() };
      save();
      return send(res, 200, { sid });
    }

    if (p === "/api/next" && req.method === "POST") {
      const b = await readBody(req);
      const trail = cleanTrail(b.trail);
      if (!trail.length) return send(res, 400, { error: "관심사를 먼저 적어줘." });
      if (isUnsafe(trail.join(" "))) return send(res, 200, { unsafe: true });
      const step = Math.max(1, Math.min(12, Number(b.step) || trail.length));
      const maxStep = Math.max(4, Math.min(9, Number(b.maxStep) || 5));
      const out = await engineNext(trail, ["easier", "other"].includes(b.mode) ? b.mode : "normal", step, maxStep, cleanTrail(b.avoid));
      const ref = getStudent(b.code, b.sid);
      if (ref) touch(ref.student, { status: "exploring", trail });
      return send(res, 200, out);
    }

    if (p === "/api/result" && req.method === "POST") {
      const b = await readBody(req);
      const trail = cleanTrail(b.trail);
      if (!trail.length) return send(res, 400, { error: "경로가 없어요." });
      if (isUnsafe(trail.join(" "))) return send(res, 200, { unsafe: true });
      const out = await engineResult(trail);
      const ref = getStudent(b.code, b.sid);
      if (ref) touch(ref.student, { status: "complete", trail, interest: out.interest, question: out.question });
      return send(res, 200, out);
    }

    if (p === "/api/exhibition" && req.method === "POST") {
      const b = await readBody(req);
      const trail = cleanTrail(b.trail);
      if (!trail.length) return send(res, 400, { error: "경로가 없어요." });
      const out = await engineExhibition(trail, clean(b.interest, 60), clean(b.question, 80));
      const ref = getStudent(b.code, b.sid);
      if (ref) touch(ref.student, { status: "exhibition", exhibition: { title: out.title, theme: out.theme, show: out.show, experience: out.experience } });
      return send(res, 200, out);
    }

    if (p === "/api/restart" && req.method === "POST") {
      const b = await readBody(req);
      const ref = getStudent(b.code, b.sid);
      if (ref) touch(ref.student, { status: "joined", trail: [], interest: null, question: null, exhibition: null });
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "서버에 문제가 생겼어요." });
  }
});

server.listen(PORT, () => {
  console.log(`DEEP DIVE 실행 중 → http://localhost:${PORT}`);
  console.log(`강사용 화면     → http://localhost:${PORT}/teacher`);
  console.log(API_KEY ? `AI 모드 (${MODEL})` : "내장 질문 엔진 모드 (ANTHROPIC_API_KEY 없음)");
});
