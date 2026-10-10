import { describe, expect, test } from "claude-code/testing";

import { askJev, buildQuestions, jevVerdicts, type JevFetch } from "./jev";

const reply = (status: number, body: unknown): ReturnType<JevFetch> =>
  Promise.resolve({ status, ok: status < 300, text: JSON.stringify(body) });
const never = () => new Promise<void>(() => {});

describe("buildQuestions", () => {
  test("每個 open ask 一題「有沒有回答」，沒標 kind 時再加一題「是不是 ask」", () => {
    const { state, questions } = buildQuestions(
      { project: "beta", text: "用 TWD" },
      [
        { id: "q1", project: "alpha", text: "要用哪個幣別？" },
        { id: "q2", project: "alpha", text: "要不要上 staging？" },
      ],
      true,
    );
    expect(Object.keys(questions)).toEqual(["answers_0", "answers_1", "isAsk"]);
    expect(Object.values(questions).every((q) => q.type === "noul")).toBe(true);
    expect(questions.answers_1?.instructions).toContain("asks[1]");
    expect(state).toEqual({
      message: { project: "beta", text: "用 TWD" },
      asks: [
        { project: "alpha", text: "要用哪個幣別？" },
        { project: "alpha", text: "要不要上 staging？" },
      ],
    });
  });

  test("已標 kind 就不問是不是 ask；沒有 open ask 也沒有要問的就是空的", () => {
    expect(
      Object.keys(
        buildQuestions({ project: "b", text: "x" }, [], false).questions,
      ),
    ).toEqual([]);
  });
});

test("指名對象時加一題「需不需要對方現在動作」，state 帶上 to", () => {
  const { state, questions } = buildQuestions({ project: "beta", text: "請今天上線", to: ["alpha"] }, [], false, true);
  expect(Object.keys(questions)).toEqual(["wake"]);
  expect(questions.wake?.type).toBe("noul");
  expect(questions.wake?.instructions).toContain("message.to");
  expect(state.message).toEqual({ project: "beta", text: "請今天上線", to: ["alpha"] });
});

describe("jevVerdicts", () => {
  const asks = [{ id: "q1" }, { id: "q2" }];

  test("超過門檻的 ask 視為已回答，訊息超過門檻視為 ask", () => {
    const verdicts = jevVerdicts(
      {
        answers_0: { type: "noul", noul: 0.91 },
        answers_1: { type: "noul", noul: 0.4 },
        isAsk: { type: "noul", noul: 0.85 },
      },
      asks,
      0.8,
    );
    expect(verdicts).toEqual({
      resolved: [{ ask: "q1", p: 0.91 }],
      maybe: [],
      isAsk: 0.85,
    });
  });

  test("0.5 到門檻之間的 ask 列為 maybe，不自動結案", () => {
    const verdicts = jevVerdicts(
      { answers_0: { type: "noul", noul: 0.76 }, answers_1: { type: "noul", noul: 0.3 } },
      asks,
      0.8,
    );
    expect(verdicts).toEqual({ resolved: [], maybe: [{ ask: "q1", p: 0.76 }] });
  });

  test("wake 回傳原始分數，門檻由收訊方判斷", () => {
    expect(jevVerdicts({ wake: { type: "noul", noul: 0.42 } }, asks, 0.8).wake).toBe(0.42);
    expect(jevVerdicts({}, asks, 0.8).wake).toBeUndefined();
  });

  test("低於門檻都不算", () => {
    expect(
      jevVerdicts({ isAsk: { type: "noul", noul: 0.5 } }, asks, 0.8),
    ).toEqual({ resolved: [], maybe: [] });
  });
});

describe("askJev", () => {
  const request = {
    state: {},
    questions: { isAsk: { type: "noul" as const, instructions: "?" } },
  };

  test("沒有 key 就略過，不打 API", async () => {
    let calls = 0;
    const fetch: JevFetch = () => ((calls += 1), reply(200, {}));
    expect(
      await askJev(request, { apiKey: undefined, fetch, timeout: never }),
    ).toEqual({
      skipped: "TYPESAFE_API_KEY not set",
    });
    expect(calls).toBe(0);
  });

  test("送出 model、state、questions 與 Bearer key", async () => {
    let seen: { url: string; init: Parameters<JevFetch>[1] } | undefined;
    const fetch: JevFetch = (url, init) => {
      seen = { url, init };
      return reply(200, { answers: { isAsk: { type: "noul", noul: 0.9 } } });
    };
    const result = await askJev(request, {
      apiKey: "k",
      fetch,
      timeout: never,
    });
    expect(result).toEqual({ answers: { isAsk: { type: "noul", noul: 0.9 } } });
    expect(seen?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen?.init.headers?.Authorization).toBe("Bearer k");
    expect(JSON.parse(seen!.init.body!)).toEqual({
      model: "jev-latest",
      ...request,
    });
  });

  test("HTTP 錯誤、缺答案、throw、逾時都變成 skipped，不會 throw", async () => {
    const opts = { apiKey: "k", timeout: never };
    expect(
      await askJev(request, { ...opts, fetch: () => reply(500, {}) }),
    ).toEqual({ skipped: "HTTP 500" });
    expect(
      await askJev(request, {
        ...opts,
        fetch: () => reply(200, { answers: {} }),
      }),
    ).toEqual({
      skipped: "response is missing answers",
    });
    expect(
      await askJev(request, {
        ...opts,
        fetch: () => Promise.reject(new Error("offline")),
      }),
    ).toEqual({
      skipped: "offline",
    });
    const hang: JevFetch = () => new Promise(() => {});
    expect(
      await askJev(request, {
        apiKey: "k",
        fetch: hang,
        timeout: () => Promise.resolve(),
      }),
    ).toEqual({
      skipped: "timed out",
    });
  });

  test("沒有任何問題就不打 API", async () => {
    let calls = 0;
    const fetch: JevFetch = () => ((calls += 1), reply(200, {}));
    expect(
      await askJev(
        { state: {}, questions: {} },
        { apiKey: "k", fetch, timeout: never },
      ),
    ).toEqual({
      skipped: "nothing to ask",
    });
    expect(calls).toBe(0);
  });
});
