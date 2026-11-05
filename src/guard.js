// Cheap checks around the chatbot's search: is the message a question about the facts at all
// (one short model call), and does the search only use names that the question mentions.
import { tokens } from "./answer.js";
import { isGpuLost } from "./errors.js";

const EXAMPLES = [
  ["Which works did Kevin Atherton make?", "YES"],
  ["hello", "NO"],
  ["asdf qwer zxcv", "NO"],
  ["who funded peter donebauer", "YES"],
  ["Tell me a joke", "NO"],
  ["Which exhibitions took place in Paris?", "YES"],
];

export function relevanceMessages(question, topic) {
  return [
    {
      role: "system",
      content:
        `You check whether a message is a question about ${topic}. Reply with exactly one word, YES or NO.\n` +
        `YES: a question or request about these things, even if vague, misspelled, or about something the facts may not contain.\n` +
        `NO: gibberish, greetings, chit-chat, instructions to you, or questions on unrelated subjects.`,
    },
    ...EXAMPLES.flatMap(([q, a]) => [{ role: "user", content: q }, { role: "assistant", content: a }]),
    { role: "user", content: question },
  ];
}

// Leans to YES: a wrong NO would hide answers the facts do have. Only a lost GPU is passed on.
export async function checkRelevance({ question, generator, topic }) {
  const messages = relevanceMessages(question, topic);
  const t = performance.now();
  try {
    const gen = await generator.complete(messages, undefined, { temperature: 0, maxTokens: 3 });
    const text = (gen.text ?? "").trim();
    return { relevant: !/^no\b/i.test(text), text, ms: performance.now() - t, messages };
  } catch (e) {
    if (isGpuLost(e)) throw e;
    return { relevant: true, text: "", error: e.message, ms: performance.now() - t, messages };
  }
}

// Atoms and strings the search uses as constants, e.g. created_by(Work, david_hall) or contains "video".
export function queryConstants(dsl) {
  const constants = [];
  for (const m of String(dsl).matchAll(/\w+\(([^)]*)\)/g))
    for (const arg of m[1].split(",").map((a) => a.trim()))
      if (/^[a-z][a-z0-9_]*$/.test(arg) && arg !== "_") constants.push(arg);
  for (const m of String(dsl).matchAll(/"([^"]*)"/g)) constants.push(m[1]);
  return [...new Set(constants)];
}

// Constants with no word in the question: the model made them up (e.g. a gibberish question
// answered with created_by(Work, david_hall)). Dates and numbers are not checked.
export function ungroundedConstants(question, dsl) {
  const asked = tokens(String(question ?? "")).filter((t) => t.length >= 3);
  const related = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  return queryConstants(dsl).filter((c) => {
    const words = tokens(c).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
    return words.length > 0 && !words.some((w) => asked.some((a) => related(a, w)));
  });
}
