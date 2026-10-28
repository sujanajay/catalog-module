export type OutputEvalsFlags = Record<string, string | string[] | true>;

/**
 * Words and flags of the catalog-output-evals CLI. A flag takes the next token as its value unless that token
 * is missing or is itself a flag; a repeated flag collects its values in a list. "--name=value" is the same as
 * "--name value": infra/catalog-output-evals.sh folds pairs into that form because gcloud refuses a repeated
 * value inside --args ("--limit 3 --bakeoff-sample 3").
 */
export function parseArgs(argv: readonly string[]): { words: string[]; flags: OutputEvalsFlags } {
  const words: string[] = [], flags: OutputEvalsFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { words.push(a); continue; }
    const eq = a.indexOf("=");
    let key: string, value: string | true;
    if (eq > 2) { key = a.slice(2, eq); value = a.slice(eq + 1); }
    else {
      const next = argv[i + 1];
      key = a.slice(2);
      value = next === undefined || next.startsWith("--") ? true : (i++, next);
    }
    const prior = flags[key];
    flags[key] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [String(prior)]), String(value)];
  }
  return { words, flags };
}
