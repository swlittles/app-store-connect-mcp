/** Short UTC timestamp, e.g. "2026-10-01 00:21Z". */
export function when(iso: string | undefined | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

export function truncate(text: string | undefined | null, max: number): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Steps of a workflow, rendered as a checklist the agent can read back to the user. */
export class StepLog {
  private readonly lines: string[] = [];

  done(text: string): void {
    this.lines.push(`✓ ${text}`);
  }

  skip(text: string): void {
    this.lines.push(`– ${text}`);
  }

  plan(text: string): void {
    this.lines.push(`→ ${text}`);
  }

  warn(text: string): void {
    this.lines.push(`! ${text}`);
  }

  fail(text: string): void {
    this.lines.push(`✗ ${text}`);
  }

  info(text: string): void {
    this.lines.push(`  ${text}`);
  }

  /** Records a step that is either planned (dry run) or done. */
  step(dryRun: boolean, text: string): void {
    if (dryRun) this.plan(text);
    else this.done(text);
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

export const STEP_LEGEND = "(✓ done, – already done or not needed, → planned, ! warning, ✗ failed)";
