import readline from "node:readline/promises";

/**
 * The few questions the installer is allowed to ask.
 *
 * Only two things are genuinely the user's to decide — which tool writes the
 * dreams and which model it uses — and neither can be guessed well: the choice
 * depends on which subscription they would rather spend, and the model list
 * changes faster than any table in this repository could.
 *
 * Everything else the installer works out for itself. And every question here
 * has a default that is taken when there is nobody to answer, so the same
 * command still works from a script or a pipe.
 */

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * A numbered list. Returns the chosen value, or null if the user picked the
 * escape option.
 *
 * @param escape  Label for "none of these"; omitted when there is no way out.
 */
export async function select(
  title: string,
  choices: Choice[],
  opts: { escape?: string; defaultIndex?: number } = {},
): Promise<string | null> {
  const fallback = choices[opts.defaultIndex ?? 0]?.value ?? null;
  if (choices.length === 0) return null;
  if (!interactive()) return fallback;

  const width = String(choices.length).length;
  const labelWidth = Math.min(28, Math.max(...choices.map((c) => c.label.length)));
  process.stdout.write(`${title}\n`);
  choices.forEach((c, i) => {
    const n = String(i + 1).padStart(width);
    const hint = c.hint ? `  ${c.hint}` : "";
    process.stdout.write(`  ${n}) ${c.label.padEnd(hint ? labelWidth : 0)}${hint}\n`);
  });
  if (opts.escape) process.stdout.write(`  ${"0".padStart(width)}) ${opts.escape}\n`);

  const def = (opts.defaultIndex ?? 0) + 1;
  for (;;) {
    const answer = await question(`Melyik? [${def}] `);
    if (answer === "") return fallback;
    if (answer === "0" && opts.escape) return null;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    process.stdout.write(`Írj egy számot 1 és ${choices.length} között${opts.escape ? ", vagy 0-t" : ""}.\n`);
  }
}

/** A free-text answer, where an empty one is meaningful. */
export async function ask(prompt: string, fallback = ""): Promise<string> {
  if (!interactive()) return fallback;
  return (await question(prompt)) || fallback;
}

export async function confirm(prompt: string, fallback = true): Promise<boolean> {
  if (!interactive()) return fallback;
  const answer = (await question(`${prompt} ${fallback ? "[I/n]" : "[i/N]"} `)).toLowerCase();
  if (answer === "") return fallback;
  return answer.startsWith("i") || answer.startsWith("y");
}
