// Grades an agent's final reply against a task's answer key (shared by run.ts and regrade.ts).

export interface AnswerKey {
  /** Regular expressions that must all match (pass/fail tasks). */
  check?: string[];
  /** One regular expression per expected item; recall is the share found (completeness tasks). */
  expect?: string[];
  /** Regular expressions for wrong items (traps); each match is a false positive. */
  forbid?: string[];
}

export interface Grade {
  passed: boolean;
  answer: string;
  /** Expected items found / expected items; 1 for check-only tasks that passed. */
  recall: number;
  falsePositives: number;
}

/** Grades the reply's `ANSWER:` line, or the whole reply when there is none. */
export function grade(key: AnswerKey, reply: string, ok: boolean): Grade {
  const answer = reply.split('\n').reverse().find((l) => /^\s*\**ANSWER:?\**/i.test(l))?.replace(/^\s*\**ANSWER:?\**\s*/i, '') ?? '';
  const graded = answer || reply;
  const matches = (re: string) => new RegExp(re, 'i').test(graded);
  const checks = key.check ?? [];
  const expected = key.expect ?? [];
  const found = expected.filter(matches).length;
  const falsePositives = (key.forbid ?? []).filter(matches).length;
  const passed = ok && checks.every(matches) && found === expected.length && falsePositives === 0;
  const recall = expected.length ? found / expected.length : passed ? 1 : 0;
  return { passed, answer: answer || reply.slice(-300), recall: ok ? recall : 0, falsePositives };
}
