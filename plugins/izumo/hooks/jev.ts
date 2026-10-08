// One call to TypeSafe's Jev, modelled on chronicle's shared/scripts/typesafe.ts.
// Every outcome comes back as a value, never a throw: Jev only sharpens what the
// explicit `kind` / `answers` fields already do, so a room works without it.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

export type JevQuestion = { type: "noul"; instructions: string };
export type JevAnswer = { type: string; noul?: number };
export type JevResult =
  | { answers: Record<string, JevAnswer> }
  | { skipped: string };

// $.http.fetch's shape, handed in so this file never touches `$`
export type JevFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>;

type Said = { project: string; text: string };

export const buildQuestions = (
  message: Said,
  openAsks: readonly (Said & { id: string })[],
  needsKind: boolean,
) => {
  const questions: Record<string, JevQuestion> = {};
  openAsks.forEach((_, n) => {
    questions[`answers_${n}`] = {
      type: "noul",
      instructions: `Does \`message.text\` give an answer or a decision to the question in \`asks[${n}].text\`, so that nobody needs to answer that question any more? A related remark, a partial reply or a new question about it does not count.`,
    };
  });
  if (needsKind)
    questions.isAsk = {
      type: "noul",
      instructions:
        "Is `message.text` asking another agent or Dylan for a reply or a decision that the writer is waiting on? A status update, an announcement or a rhetorical question does not count.",
    };
  return {
    state: {
      message,
      asks: openAsks.map(({ project, text }) => ({ project, text })),
    },
    questions,
  };
};

export const jevVerdicts = (
  answers: Record<string, JevAnswer>,
  openAsks: readonly { id: string }[],
  threshold: number,
) => {
  const resolved = openAsks.flatMap((ask, n) => {
    const p = answers[`answers_${n}`]?.noul;
    return p !== undefined && p >= threshold ? [{ ask: ask.id, p }] : [];
  });
  const isAsk = answers.isAsk?.noul;
  return isAsk !== undefined && isAsk >= threshold
    ? { resolved, isAsk }
    : { resolved };
};

export async function askJev(
  request: { state: unknown; questions: Record<string, JevQuestion> },
  opts: {
    apiKey: string | undefined;
    fetch: JevFetch;
    timeout: () => Promise<void>;
  },
): Promise<JevResult> {
  if (!opts.apiKey) return { skipped: "TYPESAFE_API_KEY not set" };
  if (Object.keys(request.questions).length === 0)
    return { skipped: "nothing to ask" };

  const call = async (): Promise<JevResult> => {
    const response = await opts.fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, ...request }),
    });
    if (!response.ok) return { skipped: `HTTP ${response.status}` };
    const { answers } = JSON.parse(response.text) as {
      answers?: Record<string, JevAnswer>;
    };
    if (!answers || Object.keys(request.questions).some((k) => !answers[k]))
      return { skipped: "response is missing answers" };
    return { answers };
  };
  // $.http.fetch has no timeout of its own
  const timedOut = opts
    .timeout()
    .then((): JevResult => ({ skipped: "timed out" }));
  try {
    return await Promise.race([call(), timedOut]);
  } catch (err) {
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}
